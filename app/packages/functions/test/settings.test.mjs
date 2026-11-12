import assert from 'node:assert/strict';
import test from 'node:test';
import { definitionDigest, signSetting, verifySetting } from '../dist/lib/integrity.js';
import { resolveSetting } from '../dist/lib/store.js';

const KEY = 'k'.repeat(48);
const WS = 'aaaaaaaa-1111-4222-8333-444444444444';
const ctxWith = (secrets) => ({ Secrets: secrets });
const row = (over = {}) => ({ workspace_id: WS, workspace_name: 'Sales', write_mode: 'in-place', in_scope: true, sig: signSetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: true }), ...over });

test('a setting verifies only for the exact workspace, mode and scope it was signed for', () => {
  const sig = signSetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: true });
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifySetting(KEY, { workspaceId: WS.toUpperCase(), writeMode: 'in-place', inScope: true }, sig), true);
  assert.equal(verifySetting(KEY, { workspaceId: WS, writeMode: 'clone', inScope: true }, sig), false);
  assert.equal(verifySetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: false }, sig), false);
  assert.equal(verifySetting(KEY, { workspaceId: '11111111-2222-3333-4444-555555555555', writeMode: 'in-place', inScope: true }, sig), false);
  assert.equal(verifySetting('z'.repeat(48), { workspaceId: WS, writeMode: 'in-place', inScope: true }, sig), false);
  assert.equal(verifySetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: true }, undefined), false);
  assert.equal(verifySetting(KEY, { workspaceId: WS, writeMode: 'in-place', inScope: true }, 'nope'), false);
});

test('a signed in-place setting is trusted', () => {
  const s = resolveSetting(ctxWith({ SIGNING_KEY: KEY }), row());
  assert.deepEqual([s.write_mode, s.unverified], ['in-place', false]);
});

test('an unsigned, tampered or unkeyed write mode falls back to propose-only and is flagged', () => {
  const unsigned = resolveSetting(ctxWith({ SIGNING_KEY: KEY }), row({ sig: undefined }));
  assert.deepEqual([unsigned.write_mode, unsigned.unverified], ['propose-only', true]);

  const widened = resolveSetting(ctxWith({ SIGNING_KEY: KEY }), row({ sig: signSetting(KEY, { workspaceId: WS, writeMode: 'propose-only', inScope: true }) }));
  assert.deepEqual([widened.write_mode, widened.unverified], ['propose-only', true]);

  const noKey = resolveSetting(ctxWith({}), row());
  assert.deepEqual([noKey.write_mode, noKey.unverified], ['propose-only', true]);
});

test('propose-only never needs a signature', () => {
  const s = resolveSetting(ctxWith({}), row({ write_mode: 'propose-only', sig: undefined }));
  assert.deepEqual([s.write_mode, s.unverified], ['propose-only', false]);
});

test('the definition digest ignores part order but not content, names or whitespace', () => {
  const a = { 'definition/model.tmdl': 'model Model\n', 'definition/tables/Sales.tmdl': 'table Sales\n' };
  const reordered = { 'definition/tables/Sales.tmdl': 'table Sales\n', 'definition/model.tmdl': 'model Model\n' };
  assert.match(definitionDigest(a), /^[0-9a-f]{64}$/);
  assert.equal(definitionDigest(a), definitionDigest(reordered));
  assert.notEqual(definitionDigest(a), definitionDigest({ ...a, 'definition/tables/Sales.tmdl': 'table Sales \n' }));
  assert.notEqual(definitionDigest(a), definitionDigest({ ...a, 'definition/tables/Other.tmdl': 'table Sales\n' }));
  assert.notEqual(definitionDigest(a), definitionDigest({ 'definition/model.tmdl': 'model Model\n' }));
});
