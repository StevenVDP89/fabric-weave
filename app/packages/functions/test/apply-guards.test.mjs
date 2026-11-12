import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChanges, buildSnapshot, sloppySalesModel } from '@rayfin-app/engine';
import { applyFixes, integrityProblems, rollbackChangeSet } from '../dist/lib/apply.js';
import { errorMessage } from '../dist/lib/runtime.js';

const claimsToken = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
const callerCtx = (upn, admins) => ({
  accessToken: claimsToken({ upn }),
  Secrets: admins ? { APP_ADMINS: admins } : {},
  getDataClient: () => ({ AuditLog: { create: async () => undefined } }),
});

test('a caller the app cannot identify cannot apply fixes or roll back, and no model is read', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return new Response('{}', { status: 500 });
  };
  try {
    const nobody = { ...callerCtx(undefined), accessToken: claimsToken({ name: 'No Identity' }), Tokens: { Fabric: 'x' } };
    const ws = 'aaaaaaaa-1111-4222-8333-444444444444';
    const model = 'bbbbbbbb-1111-4222-8333-444444444444';
    const cs = 'cccccccc-1111-4222-8333-444444444444';
    await assert.rejects(applyFixes(nobody, ws, model, [], 'a'.repeat(64)), /could not tell who you are/);
    assert.equal(fetched, 0);
    nobody.getDataClient = () => ({
      AuditLog: { create: async () => undefined },
      ChangeSet: {
        select: () => ({
          where: () => ({
            first: () => ({ execute: async () => [{ id: cs, workspace_id: ws, model_id: model, mode: 'in-place', status: 'applied' }] }),
          }),
        }),
      },
    });
    await assert.rejects(rollbackChangeSet(nobody, cs, true), /could not tell who you are/);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ids that are not GUIDs are refused before anything else happens', async () => {
  const ann = callerCtx('ann@contoso.com', 'ann@contoso.com');
  await assert.rejects(applyFixes(ann, 'ws', 'model', [], 'a'.repeat(64)), /must be a GUID/);
  await assert.rejects(rollbackChangeSet(ann, 'cs', true), /must be a GUID/);
});

test('an administrator must say which version of the model the fixes were built from', async () => {
  const ann = callerCtx('ann@contoso.com', 'ann@contoso.com');
  const ws = 'aaaaaaaa-1111-4222-8333-444444444444';
  const model = 'bbbbbbbb-1111-4222-8333-444444444444';
  for (const bad of [undefined, null, '', 'abc', 'A'.repeat(64), 5]) {
    await assert.rejects(applyFixes(ann, ws, model, [], bad), /which version of the model/);
  }
});

const key = (table, name, value) => ({ op: 'setProperty', target: { type: 'column', table, name }, property: 'isKey', value });
const snap = (parts) => buildSnapshot(parts, { name: 'Sloppy Sales' });

test('a table that would end up with two key columns is refused before anything is written', () => {
  const before = sloppySalesModel();
  const withKey = applyChanges(before, [key('dim_date', 'yr', 'true')]).parts;
  const twoKeys = applyChanges(withKey, [key('dim_date', 'dt', 'true')]).parts;

  assert.deepEqual(integrityProblems(snap(before), snap(withKey), [], before, withKey), []);
  const problems = integrityProblems(snap(before), snap(twoKeys), [], before, twoKeys);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /dim_date.*more than one key column \(dt, yr\)/);
});

test('the service error is reduced to its reason', () => {
  const raw =
    "Operation Failed: Dataset_Import_FailedToImportDataset Dataset Workload failed to import the dataset with dataset id bbbbbbbb-1111-4222-8333-444444444444. Analysis Services error. Failed to save modifications to the server. Error returned: '{\"RootActivityId\":\"FAE99261-1461-41B3-AD9C-F94DDF836025\"}\r\nThe table '<oii>dim_date</oii>' has two columns with the IsKey property set to True.\r\n{\"RootActivityId\":\"FAE99261-1461-41B3-AD9C-F94DDF836025\"}\r\n'.";
  assert.equal(errorMessage(new Error(raw)), "The service rejected the model definition: The table 'dim_date' has two columns with the IsKey property set to True.");
});

test('other errors keep their text and are capped', () => {
  assert.equal(errorMessage(new Error('plain  failure')), 'plain failure');
  assert.equal(errorMessage('x'.repeat(600)).length, 503);
});
