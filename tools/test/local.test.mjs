import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { RAYFIN_YML_HEADER, redirectUrisOf } from '../lib/common.mjs';
import {
  PATHS,
  forgetItems,
  forgetWorkspace,
  lockfileHash,
  manifestEntry,
  manifestIds,
  prepareRayfinYml,
  readBaseVersion,
  readLockStamp,
  readManifest,
  readRegistry,
  recordInstall,
  writeLockStamp,
  writeManifest,
} from '../lib/local.mjs';

// Scratch files live inside the repository folder (git-ignored), never in a system temp folder.
const SCRATCH = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.scratch-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

const WS = '00000000-0000-0000-0000-000000000000';
const BASE = ['id: demo', 'version: 9.9.9', 'services:', '  auth:', '    allowedRedirectUris:', '      - http://localhost:5173', '  data:', '    enabled: true', ''].join('\n');
const URL_A = 'https://contoso-app.webapp.fabricapps.net';
const URL_B = 'https://fabrikam-app.webapp.fabricapps.net';

function paths(name) {
  const dir = join(SCRATCH, name);
  mkdirSync(dir, { recursive: true });
  return { dir, base: join(dir, 'rayfin.base.yml'), out: join(dir, 'rayfin.yml') };
}

test('PATHS point at the generated yml, the tracked base, and files that are not tracked', () => {
  assert.match(PATHS.baseYml.replace(/\\/g, '/'), /app\/rayfin\/rayfin\.base\.yml$/);
  assert.match(PATHS.yml.replace(/\\/g, '/'), /app\/rayfin\/rayfin\.yml$/);
  assert.ok(existsSync(PATHS.baseYml), 'the tracked base config exists');
  assert.match(readBaseVersion(), /^\d+\.\d+\.\d+$/);
});

test('prepareRayfinYml generates the file from the base, and a second run changes nothing', () => {
  const p = paths('generate');
  writeFileSync(p.base, BASE);
  const first = prepareRayfinYml({ basePath: p.base, outPath: p.out });
  assert.ok(first.changed);
  assert.deepEqual(first.added, []);
  assert.equal(readFileSync(p.out, 'utf8'), `${RAYFIN_YML_HEADER}\n${BASE}`);
  assert.equal(readBaseVersion(p.base), '9.9.9');
  const second = prepareRayfinYml({ basePath: p.base, outPath: p.out });
  assert.equal(second.changed, false);
});

test('prepareRayfinYml adds the tenant URL, keeps earlier ones, and picks up edits of the base', () => {
  const p = paths('urls');
  writeFileSync(p.base, BASE);
  prepareRayfinYml({ basePath: p.base, outPath: p.out, urls: [URL_A] });
  assert.deepEqual(redirectUrisOf(readFileSync(p.out, 'utf8')), ['http://localhost:5173', URL_A]);

  const next = prepareRayfinYml({ basePath: p.base, outPath: p.out, urls: [URL_B] });
  assert.deepEqual(redirectUrisOf(next.text), ['http://localhost:5173', URL_A, URL_B], 'a URL written by an earlier run is not dropped');

  writeFileSync(p.base, BASE.replace('9.9.9', '9.9.10'));
  const edited = prepareRayfinYml({ basePath: p.base, outPath: p.out });
  assert.ok(edited.changed);
  assert.match(readFileSync(p.out, 'utf8'), /version: 9\.9\.10/);
  assert.deepEqual(redirectUrisOf(edited.text), ['http://localhost:5173', URL_A, URL_B]);
});

test('prepareRayfinYml with write:false only reports, and a missing base is an actionable error', () => {
  const p = paths('dry');
  writeFileSync(p.base, BASE);
  const result = prepareRayfinYml({ basePath: p.base, outPath: p.out, write: false });
  assert.ok(result.changed);
  assert.equal(existsSync(p.out), false);
  assert.throws(() => prepareRayfinYml({ basePath: join(p.dir, 'missing.yml'), outPath: p.out }), /is missing\. Restore it from the repository/);
});

test('readRegistry and readManifest survive a missing or damaged file', () => {
  const p = paths('files');
  assert.equal(readRegistry(join(p.dir, 'none.json')), undefined);
  writeFileSync(join(p.dir, 'bad.json'), '{not json');
  assert.equal(readRegistry(join(p.dir, 'bad.json')), undefined);
  assert.deepEqual(readManifest(join(p.dir, 'none.json')), { schema: 1, workspaces: {} });
  assert.deepEqual(readManifest(join(p.dir, 'bad.json')), { schema: 1, workspaces: {} });
  writeFileSync(join(p.dir, 'odd.json'), '[]');
  assert.deepEqual(readManifest(join(p.dir, 'odd.json')), { schema: 1, workspaces: {} });
});

test('recordInstall stores ids in lower case under the workspace, keeps what was there, and stamps the version', () => {
  const t1 = new Date('2030-01-01T00:00:00Z');
  const t2 = new Date('2030-02-01T00:00:00Z');
  const one = recordInstall({ schema: 1, workspaces: {} }, WS.toUpperCase(), { items: [{ id: 'AAA', type: 'Lakehouse', displayName: 'AIReadiness_LH' }, { type: 'Notebook' }], version: '1.0.0', now: t1 });
  assert.deepEqual(manifestIds(one, WS), ['aaa']);
  assert.equal(manifestEntry(one, WS).version, '1.0.0');
  assert.equal(manifestEntry(one, WS).installedAt, t1.toISOString());

  const two = recordInstall(one, WS, { items: [{ id: 'bbb', type: 'Notebook', displayName: 'NB_01_Scan_Inventory' }], version: '1.1.0', now: t2 });
  assert.deepEqual(manifestIds(two, WS).sort(), ['aaa', 'bbb']);
  assert.equal(manifestEntry(two, WS).version, '1.1.0');
  assert.equal(manifestEntry(two, WS).installedAt, t1.toISOString(), 'the first install date is kept');
  assert.equal(manifestEntry(two, WS).updatedAt, t2.toISOString());
  assert.deepEqual(manifestIds(one, WS), ['aaa'], 'the earlier manifest is not mutated');

  const noVersion = recordInstall(two, WS, { items: [] });
  assert.equal(manifestEntry(noVersion, WS).version, '1.1.0', 'recording items alone keeps the version');
  assert.deepEqual(manifestIds({ workspaces: {} }, 'other'), []);
});

test('forgetItems drops the removed ids and the workspace record with its last item; forgetWorkspace drops it at once', () => {
  let m = recordInstall({ schema: 1, workspaces: {} }, WS, { items: [{ id: 'a', type: 'X' }, { id: 'b', type: 'X' }], version: '1.0.0' });
  m = recordInstall(m, 'other-ws', { items: [{ id: 'z', type: 'X' }] });
  const partly = forgetItems(m, WS, ['A']);
  assert.deepEqual(manifestIds(partly, WS), ['b']);
  assert.equal(manifestEntry(partly, WS).version, '1.0.0');
  const all = forgetItems(partly, WS, ['b']);
  assert.equal(manifestEntry(all, WS), undefined);
  assert.deepEqual(manifestIds(all, 'other-ws'), ['z'], 'other workspaces are untouched');
  assert.equal(forgetItems(m, 'unknown', ['a']), m);
  assert.equal(manifestEntry(forgetWorkspace(m, WS.toUpperCase()), WS), undefined);
  assert.deepEqual(manifestIds(m, WS).sort(), ['a', 'b'], 'the original is not mutated');
});

test('the manifest round-trips through the file system', () => {
  const p = paths('manifest');
  const file = join(p.dir, '.fabric-weave.json');
  const m = recordInstall({ schema: 1, workspaces: {} }, WS, { items: [{ id: 'a', type: 'Lakehouse', displayName: 'AIReadiness_LH' }], version: '1.0.0' });
  writeManifest(m, file);
  assert.deepEqual(readManifest(file), m);
});

test('lockfileHash ignores line endings, and the lock stamp is only written where node_modules exists', () => {
  const p = paths('lock');
  const lf = join(p.dir, 'a.json');
  const crlf = join(p.dir, 'b.json');
  writeFileSync(lf, '{\n"a": 1\n}\n');
  writeFileSync(crlf, '{\r\n"a": 1\r\n}\r\n');
  assert.equal(lockfileHash(lf), lockfileHash(crlf));
  assert.match(lockfileHash(lf), /^[0-9a-f]{64}$/);
  assert.equal(lockfileHash(join(p.dir, 'none.json')), undefined);

  const stamp = join(p.dir, 'node_modules', '.stamp');
  writeLockStamp('abc', stamp);
  assert.equal(existsSync(stamp), false, 'no node_modules, no stamp');
  mkdirSync(join(p.dir, 'node_modules'));
  writeLockStamp('abc', stamp);
  assert.equal(readLockStamp(stamp), 'abc');
  assert.equal(readLockStamp(join(p.dir, 'none')), undefined);
});

test('the real app lockfile can be hashed', () => {
  assert.match(lockfileHash(), /^[0-9a-f]{64}$/);
});
