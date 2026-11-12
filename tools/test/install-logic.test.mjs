import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  RAYFIN_YML_HEADER,
  TOKEN_MAX_AGE_MS,
  TokenCache,
  azCommandLine,
  backendPlan,
  compareVersions,
  defaultAdmins,
  describeVersionChange,
  generateRayfinYml,
  installDecision,
  parseAdmins,
  parseSecretNames,
  quoteShellArg,
  readYmlVersion,
  redirectUrisOf,
  resolveAzPath,
  shouldRunPipeline,
  tokenDeadline,
  withTimeout,
} from '../lib/common.mjs';

const BASE = ['id: demo', 'version: 1.2.3', 'services:', '  auth:', '    allowedRedirectUris:', '      - http://localhost:5173', '  data:', '    enabled: true', ''].join('\n');
const jwtWith = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

// --- rayfin.yml generation -------------------------------------------------------------------------------------------

test('generateRayfinYml: the base alone gives a marked copy with no extra redirect URL', () => {
  const { text, added } = generateRayfinYml(BASE);
  assert.deepEqual(added, []);
  assert.ok(text.startsWith(`${RAYFIN_YML_HEADER}\n`));
  assert.equal(text.slice(RAYFIN_YML_HEADER.length + 1), BASE);
});

test('generateRayfinYml adds the tenant URL once, de-duplicates, and leaves the base untouched', () => {
  const url = 'https://contoso-app.webapp.fabricapps.net';
  const { text, added } = generateRayfinYml(BASE, [url, url, '', undefined, 'http://localhost:5173']);
  assert.deepEqual(added, [url]);
  assert.deepEqual(redirectUrisOf(text), ['http://localhost:5173', url]);
  assert.equal(text.match(/contoso-app/g).length, 1);
  assert.deepEqual(redirectUrisOf(BASE), ['http://localhost:5173'], 'the input text is not modified');
  assert.equal(readYmlVersion(text), '1.2.3');
});

test('generateRayfinYml keeps CRLF files CRLF and refuses junk URLs or a base without a redirect list', () => {
  const crlf = generateRayfinYml(BASE.replace(/\n/g, '\r\n'), ['https://contoso-app.example']);
  assert.ok(crlf.text.startsWith(`${RAYFIN_YML_HEADER}\r\n`));
  assert.ok(!/[^\r]\n/.test(crlf.text), 'no bare LF in a CRLF file');
  assert.throws(() => generateRayfinYml(BASE, ['javascript:alert(1)']), /not a valid redirect URL/);
  assert.throws(() => generateRayfinYml(BASE, ['https://x.example\nevil: true']), /not a valid redirect URL/);
  assert.throws(() => generateRayfinYml('id: demo\n', ['https://x.example']), /allowedRedirectUris/);
  assert.doesNotThrow(() => generateRayfinYml('id: demo\n'));
});

test('the tracked base config declares every secret, carries the release version, and has no tenant URL', () => {
  const base = readFileSync(new URL('../../app/rayfin/rayfin.base.yml', import.meta.url), 'utf8');
  for (const name of ['AOAI_ENDPOINT', 'AOAI_DEPLOYMENT', 'AOAI_API_VERSION', 'PORTFOLIO_PATH', 'SIGNING_KEY', 'APP_ADMINS']) assert.match(base, new RegExp(`- name: ${name}\\b`), name);
  assert.match(readYmlVersion(base), /^\d+\.\d+\.\d+$/);
  assert.ok(redirectUrisOf(base).length > 0);
  assert.ok(redirectUrisOf(base).every((u) => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(u)), 'only local development URLs');
  assert.ok(!/fabricapps\.net/.test(base));
});

// --- admins ------------------------------------------------------------------------------------------------------------

test('parseAdmins splits on commas, semicolons and spaces, lower-cases and de-duplicates', () => {
  assert.deepEqual(parseAdmins('A@Contoso.com, b@contoso.com;a@contoso.com  c@x.org'), { admins: ['a@contoso.com', 'b@contoso.com', 'c@x.org'], invalid: [] });
  assert.deepEqual(parseAdmins(''), { admins: [], invalid: [] });
  assert.deepEqual(parseAdmins(undefined), { admins: [], invalid: [] });
});

test('parseAdmins reports what is not a sign-in name, and accepts an object id', () => {
  const oid = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(parseAdmins(`ok@contoso.com, nope, @x.com, a@b, ${oid}`), { admins: ['ok@contoso.com', oid], invalid: ['nope', '@x.com', 'a@b'] });
});

test('parseSecretNames reads the --json list after the CLI notice, and refuses anything else', () => {
  const json = '{"status":"success","count":2,"secrets":[{"name":"SIGNING_KEY","createdAt":"x","updatedAt":"y"},{"name":"APP_ADMINS"}]}';
  assert.deepEqual(parseSecretNames(`[rayfin] using ambient token from RAYFIN_TOKEN\r\n${json}\r\n`), { ok: true, names: ['SIGNING_KEY', 'APP_ADMINS'] });
  assert.deepEqual(parseSecretNames('{"status":"success","count":0,"secrets":[]}'), { ok: true, names: [] });
  // Non-interactive output without --json carries no names: that must read as "unknown", not as "no secrets".
  assert.equal(parseSecretNames('[rayfin] using ambient token from RAYFIN_TOKEN\n').ok, false);
  assert.equal(parseSecretNames('{"status":"error","message":"nope"}').ok, false);
  assert.equal(parseSecretNames(undefined).ok, false);
});

test('defaultAdmins: the signed-in person, but never a service principal or an unreadable identity', () => {
  assert.deepEqual(defaultAdmins({ ok: true, user: 'Me@Contoso.com', type: 'user' }), { ok: true, admins: ['me@contoso.com'] });
  const oid = '5640125B-AA74-4163-B232-703C9729F1C3';
  assert.deepEqual(defaultAdmins({ ok: true, user: 'Me@Contoso.com', type: 'user' }, oid), { ok: true, admins: ['me@contoso.com', oid.toLowerCase()] });
  assert.deepEqual(defaultAdmins({ ok: true, user: 'Me@Contoso.com', type: 'user' }, 'not-a-guid'), { ok: true, admins: ['me@contoso.com'] });
  assert.equal(defaultAdmins({ ok: false, detail: 'Run: az login' }).ok, false);
  assert.match(defaultAdmins({ ok: false, detail: 'Run: az login' }).detail, /az login/);
  assert.equal(defaultAdmins({ ok: true, user: '11111111-1111-1111-1111-111111111111', type: 'servicePrincipal' }).ok, false);
  assert.equal(defaultAdmins({ ok: true, user: '11111111-1111-1111-1111-111111111111', type: 'user' }).ok, false);
  assert.equal(defaultAdmins({ ok: true, user: 'not-an-email', type: 'user' }).ok, false);
  assert.equal(defaultAdmins({ ok: true, type: 'user' }).ok, false);
  assert.equal(defaultAdmins(undefined).ok, false);
});

// --- dependencies, versions, pipeline run ------------------------------------------------------------------------------

test('installDecision: npm ci when node_modules is missing or does not match the lockfile', () => {
  assert.equal(installDecision({ hasNodeModules: false, lockHash: 'a', stampHash: 'a' }).install, true);
  assert.equal(installDecision({ hasNodeModules: true, lockHash: undefined, stampHash: 'a' }).install, true);
  const unstamped = installDecision({ hasNodeModules: true, lockHash: 'a', stampHash: undefined });
  assert.ok(unstamped.install);
  assert.match(unstamped.reason, /not installed by this installer/);
  assert.match(installDecision({ hasNodeModules: true, lockHash: 'b', stampHash: 'a' }).reason, /changed/);
  assert.deepEqual(installDecision({ hasNodeModules: true, lockHash: 'a', stampHash: 'a' }), { install: false, reason: 'node_modules matches package-lock.json' });
});

test('compareVersions orders by major.minor.patch and ignores a pre-release suffix', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0);
  assert.equal(compareVersions(undefined, '0.0.1'), -1);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('1.2', '1.2.1'), -1);
});

test('describeVersionChange says install, upgrade, downgrade or same', () => {
  assert.deepEqual(describeVersionChange(undefined, '1.0.0'), { kind: 'install', text: 'installing v1.0.0' });
  assert.equal(describeVersionChange(undefined, '1.0.0', { legacy: true }).kind, 'upgrade');
  assert.equal(describeVersionChange('1.0.0', '1.0.0').kind, 'same');
  assert.equal(describeVersionChange('1.0.0', '1.1.0').text, 'upgrading from v1.0.0 to v1.1.0');
  const down = describeVersionChange('1.2.0', '1.1.0');
  assert.equal(down.kind, 'downgrade');
  assert.match(down.text, /older/);
  assert.equal(describeVersionChange('1.0.0', '1.0.0-rc.1').kind, 'change');
});

test('shouldRunPipeline: run the first time, skip when a portfolio exists, flags win', () => {
  assert.equal(shouldRunPipeline({ portfolioExists: false }).run, true);
  const skip = shouldRunPipeline({ portfolioExists: true });
  assert.equal(skip.run, false);
  assert.match(skip.reason, /--run-pipeline/);
  assert.equal(shouldRunPipeline({ portfolioExists: true, run: true }).run, true);
  assert.equal(shouldRunPipeline({ portfolioExists: false, noRun: true }).run, false);
  assert.equal(shouldRunPipeline({ portfolioExists: false, run: true, noRun: true }).run, false);
});

test('backendPlan: full by default; --skip-backend needs a lakehouse; --app-only excludes the scan options', () => {
  const LH = '5fce83e5-7ce2-428c-8695-0fbf583afdcf';
  assert.deepEqual(backendPlan({}), { mode: 'full', ok: true });
  assert.deepEqual(backendPlan(undefined), { mode: 'full', ok: true });
  assert.deepEqual(backendPlan({ 'run-pipeline': true }), { mode: 'full', ok: true });

  assert.deepEqual(backendPlan({ 'skip-backend': true, lakehouse: LH }), { mode: 'existing', ok: true, lakehouseId: LH });
  for (const bad of [{ 'skip-backend': true }, { 'skip-backend': true, lakehouse: 'nope' }, { 'skip-backend': true, lakehouse: true }]) {
    const plan = backendPlan(bad);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /--lakehouse/);
    assert.match(plan.error, /--app-only/);
  }
  assert.deepEqual(backendPlan({ lakehouse: LH }), { mode: 'full', ok: true });

  assert.deepEqual(backendPlan({ 'app-only': true }), { mode: 'app-only', ok: true });
  assert.deepEqual(backendPlan({ 'app-only': true, 'no-run-pipeline': true }), { mode: 'app-only', ok: true });
  for (const [flag, name] of [[{ 'skip-backend': true }, '--skip-backend'], [{ lakehouse: LH }, '--lakehouse'], [{ 'run-pipeline': true }, '--run-pipeline'], [{ 'reset-schedule': true }, '--reset-schedule']]) {
    const plan = backendPlan({ 'app-only': true, ...flag });
    assert.equal(plan.ok, false, name);
    assert.equal(plan.mode, 'app-only');
    assert.ok(plan.error.includes(name), name);
  }
});

// --- Azure CLI command resolution (pure) -------------------------------------------------------------------------------

test('resolveAzPath: AZURE_CLI_PATH first, then the Windows install folders, then plain az', () => {
  const win = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd';
  assert.equal(resolveAzPath({ env: {}, platform: 'linux', exists: () => true }), 'az', 'no Windows paths on Linux');
  assert.equal(resolveAzPath({ env: {}, platform: 'darwin', exists: () => false }), 'az');
  assert.equal(resolveAzPath({ env: { AZURE_CLI_PATH: '/opt/az' }, platform: 'linux', exists: (p) => p === '/opt/az' }), '/opt/az');
  assert.equal(resolveAzPath({ env: { AZURE_CLI_PATH: '/missing/az' }, platform: 'linux', exists: () => false }), 'az', 'a path that does not exist is ignored');
  assert.equal(resolveAzPath({ env: {}, platform: 'win32', exists: (p) => p === win }), win);
  assert.equal(resolveAzPath({ env: {}, platform: 'win32', exists: () => false }), 'az');
});

test('quoteShellArg leaves plain words alone and quotes the rest for the right shell', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(quoteShellArg('account', platform), 'account');
    assert.equal(quoteShellArg('--resource=https://api.fabric.microsoft.com', platform), '--resource=https://api.fabric.microsoft.com');
  }
  assert.equal(quoteShellArg('a b', 'win32'), '"a b"');
  assert.equal(quoteShellArg('say "hi"', 'win32'), '"say ""hi"""');
  assert.equal(quoteShellArg('a b', 'linux'), "'a b'");
  assert.equal(quoteShellArg("it's", 'linux'), `'it'\\''s'`);
  assert.equal(quoteShellArg('$(rm -rf ~)', 'linux'), "'$(rm -rf ~)'", 'no shell expansion on Linux');
  assert.equal(quoteShellArg('', 'linux'), "''");
});

test('azCommandLine builds one command string per platform', () => {
  const args = ['account', 'get-access-token', '--resource', 'https://api.fabric.microsoft.com', '--query', 'accessToken', '-o', 'tsv'];
  assert.equal(azCommandLine(args, { env: {}, platform: 'linux' }), 'az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv');
  assert.equal(azCommandLine(['account', 'show', '--query', 'user.name and x'], { env: {}, platform: 'linux' }), "az account show --query 'user.name and x'");
  const win = 'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd';
  assert.equal(azCommandLine(['account', 'show'], { env: {}, platform: 'win32', exists: (p) => p === win }), `"${win}" account show`);
  assert.equal(azCommandLine(['version'], { env: { AZURE_CLI_PATH: '/usr/local/bin/az' }, platform: 'darwin', exists: () => true }), '/usr/local/bin/az version');
});

// --- tokens and timeouts -----------------------------------------------------------------------------------------------

test('tokenDeadline is the earlier of the maximum age and the token expiry minus a minute', () => {
  const now = 1_700_000_000_000;
  assert.equal(tokenDeadline(jwtWith({}), now), now + TOKEN_MAX_AGE_MS, 'no exp claim');
  assert.equal(tokenDeadline('garbage', now), now + TOKEN_MAX_AGE_MS);
  assert.equal(tokenDeadline(jwtWith({ exp: now / 1000 + 3600 }), now), now + TOKEN_MAX_AGE_MS, 'a long-lived token is still re-read every ten minutes');
  assert.equal(tokenDeadline(jwtWith({ exp: now / 1000 + 120 }), now), now + 60_000, 'a token about to expire is replaced early');
  assert.ok(tokenDeadline(jwtWith({ exp: now / 1000 - 5 }), now) < now, 'an expired token is already stale');
});

test('TokenCache reuses a token until it is old or about to expire, per resource', () => {
  let clock = 1_700_000_000_000;
  let issued = 0;
  const cache = new TokenCache((resource) => jwtWith({ resource, n: ++issued, exp: clock / 1000 + 3600 }), { now: () => clock });
  const first = cache.get('fabric');
  assert.equal(cache.get('fabric'), first);
  assert.notEqual(cache.get('onelake'), first, 'each resource has its own token');
  assert.equal(issued, 2);
  clock += TOKEN_MAX_AGE_MS - 1;
  assert.equal(cache.get('fabric'), first, 'still fresh just before ten minutes');
  clock += 2;
  assert.notEqual(cache.get('fabric'), first, 'replaced after ten minutes');
  assert.equal(issued, 3);

  clock = 1_800_000_000_000;
  const shortLived = new TokenCache(() => jwtWith({ n: ++issued, exp: clock / 1000 + 90 }), { now: () => clock });
  const t1 = shortLived.get('r');
  clock += 40_000;
  assert.notEqual(shortLived.get('r'), t1, 'a token that expires within the minute margin is replaced');
});

test('withTimeout passes a signal and turns a timeout into a readable error', async () => {
  let signal;
  const ok = withTimeout(async (url, init) => ((signal = init.signal), new Response('{}')), 5000);
  await ok('https://example.test/a', { method: 'POST' });
  assert.ok(signal instanceof AbortSignal);

  const slow = withTimeout((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), 20);
  await assert.rejects(() => slow('https://example.test/items?x=secret', { method: 'DELETE' }), (e) => {
    assert.match(e.message, /^DELETE https:\/\/example\.test\/items did not answer within \d+ seconds?$/);
    assert.ok(!e.message.includes('secret'), 'the query string is not echoed');
    return true;
  });

  const broken = withTimeout(async () => { throw new TypeError('fetch failed'); }, 20);
  await assert.rejects(() => broken('https://example.test'), /fetch failed/);

  const own = new AbortController();
  let used;
  await withTimeout(async (url, init) => ((used = init.signal), new Response('{}')), 20)('https://example.test', { signal: own.signal });
  assert.equal(used, own.signal, 'a caller-supplied signal wins');
});
