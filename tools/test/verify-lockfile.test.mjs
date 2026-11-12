import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockEntries, integrityMatches } from '../verify-lockfile.mjs';

test('lockEntries takes registry packages and skips the root, links and entries without integrity', () => {
  const lock = {
    packages: {
      '': { name: 'root' },
      'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: 'sha512-AAA' },
      'node_modules/@s/b': { version: '2.0.0', resolved: 'https://registry.npmjs.org/@s/b/-/b-2.0.0.tgz', integrity: 'sha512-BBB' },
      'node_modules/x/node_modules/c': { version: '3.0.0', resolved: 'https://registry.npmjs.org/c/-/c-3.0.0.tgz', integrity: 'sha512-CCC' },
      'node_modules/link': { link: true, resolved: 'packages/link' },
      'packages/local': { version: '0.0.0' },
      'node_modules/noint': { version: '1.0.0', resolved: 'https://registry.npmjs.org/n/-/n-1.0.0.tgz' },
      'node_modules/alias': { name: 'real', version: '1.0.0', resolved: 'https://registry.npmjs.org/real/-/real-1.0.0.tgz', integrity: 'sha512-DDD' },
    },
  };
  assert.deepEqual(lockEntries(lock).map((e) => `${e.name}@${e.version}`), ['a@1.0.0', '@s/b@2.0.0', 'c@3.0.0', 'real@1.0.0']);
});

test('integrityMatches compares sha512 values exactly', () => {
  assert.equal(integrityMatches('sha512-AAA', { integrity: 'sha512-AAA' }), true);
  assert.equal(integrityMatches('sha512-AAA', { integrity: 'sha512-BBB' }), false);
});

test('integrityMatches accepts a sha1 lock value via the published shasum', () => {
  const shasum = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
  const sha1 = `sha1-${Buffer.from(shasum, 'hex').toString('base64')}`;
  assert.equal(integrityMatches(sha1, { shasum }), true);
  assert.equal(integrityMatches(sha1, { shasum: '0'.repeat(40) }), false);
});
