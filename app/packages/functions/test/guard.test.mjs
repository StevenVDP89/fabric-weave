import assert from 'node:assert/strict';
import test from 'node:test';
import { UserDataFunctionError, UserThrownError } from '@microsoft/fabric-user-data-functions';
import { guarded, publicMessage } from '../dist/lib/guard.js';

function fakeCtx(auditRows, failAudit = false) {
  return {
    accessToken: 'a.b.c',
    getDataClient: () => ({
      AuditLog: {
        create: async (row) => {
          if (failAudit) throw new Error('audit store is down');
          auditRows.push(row);
          return row;
        },
      },
    }),
  };
}

test('a plain error is rethrown as a UserThrownError that keeps the real message', async () => {
  const rows = [];
  await assert.rejects(
    guarded('applyFixes', fakeCtx(rows), async () => {
      throw new Error('Saving the rollback snapshot failed: column too long');
    }),
    (e) => e instanceof UserThrownError && e.message === 'Saving the rollback snapshot failed: column too long',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'function.error');
  assert.equal(rows[0].outcome, 'error');
  assert.match(rows[0].details, /^applyFixes: Saving the rollback snapshot failed/);
});

test('errors the platform already understands pass through untouched', async () => {
  const rows = [];
  const original = new UserDataFunctionError('InvalidInput', 'bad input');
  await assert.rejects(
    guarded('listModels', fakeCtx(rows), async () => {
      throw original;
    }),
    (e) => e === original,
  );
  assert.equal(rows.length, 0);
});

test('a result passes straight through', async () => {
  assert.deepEqual(await guarded('x', fakeCtx([]), async () => ({ ok: true })), { ok: true });
});

test('a failing audit store does not hide the original error', async () => {
  await assert.rejects(
    guarded('assessModel', fakeCtx([], true), async () => {
      throw new Error('Fabric said no');
    }),
    (e) => e instanceof UserThrownError && e.message === 'Fabric said no',
  );
});

test('tokens are removed and long messages are capped', () => {
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${'a'.repeat(40)}.${'b'.repeat(40)}`;
  const m = publicMessage(new Error(`Fabric returned 401 for Bearer ${jwt} and ${jwt}`));
  assert.ok(!m.includes('eyJ'));
  assert.match(m, /\[token\]/);
  const long = publicMessage(new Error('x'.repeat(5000)));
  assert.ok(long.length <= 1003);
  assert.equal(publicMessage(new Error('   ')), 'Unexpected error');
  assert.equal(publicMessage('plain text'), 'plain text');
});
