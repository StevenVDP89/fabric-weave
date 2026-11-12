import assert from 'node:assert/strict';
import test from 'node:test';
import { FabricApiError, findOneLakeSources } from '@rayfin-app/engine';
import { explainFabricWriteError, unreachableSources } from '../dist/lib/sourceCheck.js';

const WS = 'aaaaaaaa-1111-4222-8333-444444444444';
const LH = 'dddddddd-1111-4222-8333-444444444444';
const expressions = `expression 'DirectLake - Lakehouse_Ignite' =
\t\tlet
\t\t    Source = AzureStorage.DataLake("https://onelake.dfs.fabric.microsoft.com/${WS}/${LH}", [HierarchicalNavigation=true])
\t\tin
\t\t    Source
\tlineageTag: eeeeeeee-1111-4222-8333-444444444444
`;
const parts = { 'definition/expressions.tmdl': expressions, 'definition/model.tmdl': 'model Model\n\tculture: en-US\n' };

test('finds the lakehouse a Direct Lake model reads from', () => {
  assert.deepEqual(findOneLakeSources(parts), [{ workspaceId: WS, itemId: LH, expression: 'DirectLake - Lakehouse_Ignite' }]);
});

test('a model without a OneLake source has nothing to check', () => {
  assert.deepEqual(findOneLakeSources({ 'definition/model.tmdl': 'model Model\n' }), []);
});

test('the same source mentioned twice is reported once', () => {
  assert.equal(findOneLakeSources({ 'a.tmdl': expressions, 'b.tmdl': expressions }).length, 1);
});

test('a source that cannot be found is reported, one that exists is not', async () => {
  const gone = { getItem: async () => Promise.reject(new FabricApiError(404, 'not found', 'u')) };
  const there = { getItem: async () => ({ id: LH }) };
  const problems = await unreachableSources(gone, parts);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes(LH) && problems[0].includes(WS));
  assert.deepEqual(await unreachableSources(there, parts), []);
});

test('a source the app has no access to is reported too', async () => {
  const noAccess = { getItem: async () => Promise.reject(new FabricApiError(403, 'forbidden', 'u')) };
  assert.equal((await unreachableSources(noAccess, parts)).length, 1);
});

test('a transient failure does not block a change', async () => {
  const flaky = { getItem: async () => Promise.reject(new FabricApiError(500, 'oops', 'u')) };
  const broken = { getItem: async () => Promise.reject(new Error('socket hang up')) };
  assert.deepEqual(await unreachableSources(flaky, parts), []);
  assert.deepEqual(await unreachableSources(broken, parts), []);
});

test('the raw Fabric rejection is turned into advice, other errors are left alone', () => {
  const raw = `The service rejected the model definition: The Fabric artifact '${LH}' is not found, or you do not have permission to access the artifact.`;
  const out = explainFabricWriteError(raw);
  assert.ok(out.includes(LH) && /propose-only/.test(out) && !/do not have permission/.test(out));
  assert.equal(explainFabricWriteError('Something else failed'), 'Something else failed');
});
