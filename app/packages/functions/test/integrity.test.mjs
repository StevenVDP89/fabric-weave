import assert from 'node:assert/strict';
import test from 'node:test';
import { digestChunks, definitionDigest, disallowedPartPaths, signSetting, signSnapshot, usableSigningKey, verifySetting, verifySnapshot } from '../dist/lib/integrity.js';

const KEY = 'k'.repeat(48);
const binding = {
  workspaceId: 'aaaaaaaa-1111-4222-8333-444444444444',
  modelId: 'bbbbbbbb-1111-4222-8333-444444444444',
  snapshotId: 'cccccccc-1111-4222-8333-444444444444',
  digest: digestChunks(['abc', 'def']),
};
const OTHER = '11111111-2222-3333-4444-555555555555';

test('a signature verifies for the binding it was made for', () => {
  const sig = signSnapshot(KEY, binding);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(verifySnapshot(KEY, binding, sig), true);
});

test('guids are compared case-insensitively', () => {
  const sig = signSnapshot(KEY, binding);
  assert.equal(verifySnapshot(KEY, { ...binding, modelId: binding.modelId.toUpperCase() }, sig), true);
});

test('changing the model, workspace, snapshot or content breaks verification', () => {
  const sig = signSnapshot(KEY, binding);
  assert.equal(verifySnapshot(KEY, { ...binding, modelId: OTHER }, sig), false);
  assert.equal(verifySnapshot(KEY, { ...binding, workspaceId: OTHER }, sig), false);
  assert.equal(verifySnapshot(KEY, { ...binding, snapshotId: OTHER }, sig), false);
  assert.equal(verifySnapshot(KEY, { ...binding, digest: digestChunks(['abc', 'tampered']) }, sig), false);
});

test('a different key, a missing signature or a malformed signature never verifies', () => {
  const sig = signSnapshot(KEY, binding);
  assert.equal(verifySnapshot('z'.repeat(48), binding, sig), false);
  assert.equal(verifySnapshot(KEY, binding, undefined), false);
  assert.equal(verifySnapshot(KEY, binding, null), false);
  assert.equal(verifySnapshot(KEY, binding, ''), false);
  assert.equal(verifySnapshot(KEY, binding, 'not-hex'), false);
  assert.equal(verifySnapshot(KEY, binding, sig.slice(0, 62)), false);
});

test('the digest depends on the order and content of the chunks', () => {
  assert.equal(digestChunks(['a', 'b']), digestChunks(['a', 'b']));
  assert.notEqual(digestChunks(['a', 'b']), digestChunks(['b', 'a']));
  assert.notEqual(digestChunks(['a', 'b']), digestChunks(['a', 'c']));
});

test('only a long enough key is usable', () => {
  assert.equal(usableSigningKey(undefined), false);
  assert.equal(usableSigningKey('short'), false);
  assert.equal(usableSigningKey(' '.repeat(40)), false);
  assert.equal(usableSigningKey(KEY), true);
});

test('only model definition parts may be restored', () => {
  assert.deepEqual(
    disallowedPartPaths([
      'definition.pbism',
      'definition/model.tmdl',
      'definition/database.tmdl',
      'definition/tables/Sales Orders.tmdl',
      'definition/cultures/en-US.tmdl',
      'definition/copilot/instructions.json',
      'Copilot/Instructions/instructions.md',
      'Copilot/Instructions/version.json',
      'Copilot/schema.json',
      'Copilot/examplePrompts.json',
    ]),
    [],
  );
  const bad = ['.platform', 'diagramLayout.json', '../definition/model.tmdl', 'definition/../x.tmdl', '/definition/model.tmdl', 'definition\\model.tmdl', 'definition/model.exe', 'notes.txt', 'definition/', 'Copilot/../.platform', 'Copilot/run.md.exe', 'copilot-x/schema.json'];
  assert.deepEqual(disallowedPartPaths(bad), bad);
});
