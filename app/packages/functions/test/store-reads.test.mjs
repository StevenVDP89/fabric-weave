import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { GraphQLEntityClient } from '@microsoft/rayfin-data';
import { signSetting } from '../dist/lib/integrity.js';
import { readAssessmentRow, readBusinessContext, readSetting } from '../dist/lib/store.js';

const KEY = 'k'.repeat(48);

/**
 * A GraphQL transport that behaves like the real data API: it returns only the fields the query
 * selects. The data client selects just `id` when no fields are named, which is how an in-scope
 * workspace came back as "not enabled for changes".
 */
function fakeCtx(tables) {
  const transport = {
    query: async (q) => {
      const plural = /query\s*\{\s*(\w+)/.exec(q)[1];
      const selection = /items\s*\{([^}]*)\}/.exec(q)[1].split(/\s+/).filter(Boolean);
      const items = (tables[plural] ?? []).map((row) => Object.fromEntries(selection.map((f) => [f, row[f] ?? null])));
      return { data: { [plural]: { items } } };
    },
  };
  const entities = ['WorkspaceSetting', 'ModelAssessment', 'BusinessContext', 'ChangeSet'];
  const client = Object.fromEntries(entities.map((e) => [e, new GraphQLEntityClient(transport, e)]));
  return { getDataClient: () => client, Secrets: { SIGNING_KEY: KEY } };
}

const WS = 'aaaaaaaa-1111-4222-8333-444444444444';
const MODEL = 'bbbbbbbb-1111-4222-8333-444444444444';

test('readSetting returns the stored write mode and scope when the app signed it', async () => {
  const sig = signSetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: true });
  const ctx = fakeCtx({
    workspaceSettings: [{ id: 'x', workspace_id: WS, workspace_name: 'NYC-TLC-Medallion', write_mode: 'in-place', in_scope: true, sig }],
  });
  assert.deepEqual(await readSetting(ctx, WS), { write_mode: 'in-place', in_scope: true, workspace_name: 'NYC-TLC-Medallion', unverified: false });
});

test('readSetting ignores an in-place mode that the app did not sign', async () => {
  const ctx = fakeCtx({
    workspaceSettings: [{ id: 'x', workspace_id: WS, workspace_name: 'NYC-TLC-Medallion', write_mode: 'in-place', in_scope: true }],
  });
  assert.deepEqual(await readSetting(ctx, WS), { write_mode: 'propose-only', in_scope: true, workspace_name: 'NYC-TLC-Medallion', unverified: true });
});

test('readSetting returns undefined when nothing is stored', async () => {
  assert.equal(await readSetting(fakeCtx({ workspaceSettings: [] }), WS), undefined);
});

test('readAssessmentRow returns the approval attestation and name', async () => {
  const ctx = fakeCtx({ modelAssessments: [{ id: 'a', model_id: MODEL, model_name: 'NYC Taxi Trips', approved_for_copilot: true }] });
  const row = await readAssessmentRow(ctx, MODEL);
  assert.equal(row.approved_for_copilot, true);
  assert.equal(row.model_name, 'NYC Taxi Trips');
  assert.equal(row.id, 'a');
});

test('readBusinessContext returns the saved context', async () => {
  const ctx = fakeCtx({
    businessContexts: [{ id: 'b', domain: 'Urban mobility', audience: 'Analysts', glossary_json: '[{"term":"Fare","meaning":"Amount charged"}]', preferred_measures: 'Total fare|Trips' }],
  });
  const c = await readBusinessContext(ctx, MODEL);
  assert.equal(c.domain, 'Urban mobility');
  assert.equal(c.audience, 'Analysts');
  assert.deepEqual(c.glossary, [{ term: 'Fare', meaning: 'Amount charged' }]);
  assert.deepEqual(c.preferredMeasures, ['Total fare', 'Trips']);
});

test('readBusinessContext prefers the free-text description over the older fields', async () => {
  const ctx = fakeCtx({
    businessContexts: [{ id: 'b', context_text: '  Taxi trips in New York. Fiscal year starts in July.  ', domain: 'Old domain', audience: 'Old audience' }],
  });
  const c = await readBusinessContext(ctx, MODEL);
  assert.deepEqual(c, { description: 'Taxi trips in New York. Fiscal year starts in July.' });
});

test('readBusinessContext falls back to the older fields when the text is blank', async () => {
  const ctx = fakeCtx({ businessContexts: [{ id: 'b', context_text: '   ', domain: 'Urban mobility' }] });
  const c = await readBusinessContext(ctx, MODEL);
  assert.equal(c.domain, 'Urban mobility');
  assert.equal(c.description, undefined);
});

test('no code reads full rows through findFirst, findMany or findById (they return only the id)', () => {
  const roots = [join(import.meta.dirname, '..', 'src'), join(import.meta.dirname, '..', '..', 'frontend', 'src')];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && /\.(findFirst|findMany|findById)\(/.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  roots.forEach(walk);
  assert.deepEqual(offenders, []);
});
