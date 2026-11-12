import assert from 'node:assert/strict';
import test from 'node:test';
import { sloppySalesModel } from '@rayfin-app/engine';
import { forgetModel, loadModel, loadModelCached } from '../dist/lib/views.js';

/** A Fabric client that counts how often the definition is exported. */
function fakeClient({ failFirst = false, delayMs = 0 } = {}) {
  const counts = { getDefinition: 0 };
  const client = {
    getWorkspace: async () => ({ id: 'w', displayName: 'Workspace', capacityId: undefined }),
    getDataset: async () => ({ name: 'Sloppy Sales' }),
    lastRefresh: async () => undefined,
    listCapacities: async () => [],
    getDefinition: async () => {
      counts.getDefinition += 1;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (failFirst && counts.getDefinition === 1) throw new Error('export failed');
      return sloppySalesModel();
    },
  };
  return { client, counts };
}

const ids = (n) => [`00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, `11111111-1111-4111-8111-1111111111${String(n).padStart(2, '0')}`];

test('a second read of the same model comes from memory, without exporting again', async () => {
  const { client, counts } = fakeClient();
  const [ws, mid] = ids(1);
  const first = await loadModelCached(client, ws, mid, null);
  const second = await loadModelCached(client, ws, mid, null);
  assert.equal(counts.getDefinition, 1);
  assert.equal(second, first);
  assert.equal(first.modelName, 'Sloppy Sales');
});

test('callers that arrive together share one export', async () => {
  const { client, counts } = fakeClient({ delayMs: 20 });
  const [ws, mid] = ids(2);
  const reads = await Promise.all([loadModelCached(client, ws, mid, null), loadModelCached(client, ws, mid, null), loadModelCached(client, ws, mid, null)]);
  assert.equal(counts.getDefinition, 1);
  assert.equal(reads[0], reads[2]);
});

test('ids are matched without regard to case', async () => {
  const { client, counts } = fakeClient();
  const [ws, mid] = ids(3);
  await loadModelCached(client, ws.toUpperCase(), mid.toUpperCase(), null);
  await loadModelCached(client, ws, mid, null);
  assert.equal(counts.getDefinition, 1);
});

test('a failed export is not remembered', async () => {
  const { client, counts } = fakeClient({ failFirst: true });
  const [ws, mid] = ids(4);
  await assert.rejects(loadModelCached(client, ws, mid, null), /export failed/);
  const retry = await loadModelCached(client, ws, mid, null);
  assert.equal(counts.getDefinition, 2);
  assert.equal(retry.modelName, 'Sloppy Sales');
});

test('a fresh read always goes to Fabric, and refreshes what the cache serves', async () => {
  const { client, counts } = fakeClient();
  const [ws, mid] = ids(5);
  await loadModelCached(client, ws, mid, null);
  const fresh = await loadModel(client, ws, mid, null);
  assert.equal(counts.getDefinition, 2, 'loadModel does not trust the cache');
  assert.equal(await loadModelCached(client, ws, mid, null), fresh);
  assert.equal(counts.getDefinition, 2);
});

test('forgetting a model makes the next cached read export again', async () => {
  const { client, counts } = fakeClient();
  const [ws, mid] = ids(6);
  await loadModelCached(client, ws, mid, null);
  forgetModel(ws, mid);
  await loadModelCached(client, ws, mid, null);
  assert.equal(counts.getDefinition, 2);
});

test('the cache stays bounded', async () => {
  const { client, counts } = fakeClient();
  for (let i = 10; i < 50; i += 1) {
    const [ws, mid] = ids(i);
    await loadModelCached(client, ws, mid, null);
  }
  const before = counts.getDefinition;
  const [ws, mid] = ids(10);
  await loadModelCached(client, ws, mid, null);
  assert.equal(counts.getDefinition, before + 1, 'the oldest entry was evicted');
  const [newestWs, newestMid] = ids(49);
  await loadModelCached(client, newestWs, newestMid, null);
  assert.equal(counts.getDefinition, before + 1, 'the newest entry is still there');
});
