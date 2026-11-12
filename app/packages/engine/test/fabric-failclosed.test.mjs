import assert from 'node:assert/strict';
import test from 'node:test';
import { FabricClient, assertModelDefinition, sloppySalesModel } from '../dist/index.js';

const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const accepted = () => new Response(null, { status: 202, headers: { location: 'https://api.fabric.microsoft.com/v1/operations/op1', 'retry-after': '1' } });
const part = (path, text = '{}') => ({ path, payload: Buffer.from(text).toString('base64'), payloadType: 'InlineBase64' });

/** A fetch that answers getDefinition with `accept`, the poll with `poll` and the result with `result`. */
function fabricStub({ accept = accepted, poll = () => json({ status: 'Succeeded' }), result = () => json({ definition: { parts: [part('definition.pbism')] } }) } = {}) {
  return async (url) => {
    const target = String(url).split('?')[0];
    if (target.endsWith('/getDefinition')) return accept();
    if (target.endsWith('/operations/op1/result')) return result();
    if (target.endsWith('/operations/op1')) return poll();
    throw new Error(`unexpected request ${target}`);
  };
}
const client = (opts) => new FabricClient({ getToken: async () => 'token', lroPollMs: 1, fetchImpl: fabricStub(opts) });

test('an export that finishes normally is returned', async () => {
  const parts = await client().getDefinition('ws', 'model');
  assert.deepEqual(Object.keys(parts), ['definition.pbism']);
});

test('an export with no parts is an error, never an empty model', async () => {
  await assert.rejects(client({ result: () => json({ definition: { parts: [] } }) }).getDefinition('ws', 'model'), /no definition/);
  await assert.rejects(client({ result: () => json({}) }).getDefinition('ws', 'model'), /no definition/);
});

test('an export whose result cannot be fetched is an error', async () => {
  await assert.rejects(client({ result: () => new Response('gone', { status: 404 }) }).getDefinition('ws', 'model'), /404/);
});

test('an export that is accepted without a Location header is an error', async () => {
  await assert.rejects(client({ accept: () => new Response(null, { status: 202 }) }).getDefinition('ws', 'model'), /did not say where to fetch the result/);
});

test('an export that fails in Fabric is an error', async () => {
  await assert.rejects(client({ poll: () => json({ status: 'Failed', error: { errorCode: 'Boom', message: 'nope' } }) }).getDefinition('ws', 'model'), /Operation Failed: Boom nope/);
});

test('only a whole model definition passes the safety check', () => {
  assert.doesNotThrow(() => assertModelDefinition(sloppySalesModel()));

  const whole = sloppySalesModel();
  const without = (pred) => Object.fromEntries(Object.entries(whole).filter(([p]) => !pred(p)));
  assert.throws(() => assertModelDefinition({}), /definition\.pbism is missing.*model\.tmdl.*no tables/);
  assert.throws(() => assertModelDefinition(without((p) => p === 'definition.pbism')), /definition\.pbism is missing/);
  assert.throws(() => assertModelDefinition(without((p) => /^definition\/tables\//.test(p))), /no tables/);
  assert.throws(() => assertModelDefinition(without((p) => /model\.tmdl$|database\.tmdl$/.test(p))), /model\.tmdl\) is missing/);
});
