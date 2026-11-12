import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  APP_ITEM_NAME,
  GUID,
  checkAoaiEndpoint,
  checkCapacity,
  checkNodeVersion,
  checkWorkspaceRole,
  classifyItems,
  decideAdoption,
  describeWorkspaceContents,
  ensureRedirectUri,
  findDeploymentByWorkspace,
  findPrivateLockfileHosts,
  isManagedItem,
  itemNameArgs,
  managedDescription,
  managedVersion,
  parseFlags,
  pickExistingAppName,
  readJwtClaims,
  removeDeploymentByWorkspace,
  resolveRoleFromAssignments,
} from '../lib/common.mjs';

const WS = '00000000-0000-0000-0000-000000000000';

test('GUID accepts workspace ids and rejects junk', () => {
  assert.ok(GUID.test(WS));
  assert.ok(GUID.test('ABCDEF00-0000-0000-0000-000000000000'));
  assert.ok(!GUID.test('not-a-guid'));
  assert.ok(!GUID.test(`${WS}x`));
});

test('checkNodeVersion allows Node 20 to 24, and warns that Node 20 is end of life', () => {
  for (const v of ['v22.11.0', '24.21.0']) assert.ok(checkNodeVersion(v).ok && !checkNodeVersion(v).warn, v);
  const node20 = checkNodeVersion('20.0.0');
  assert.ok(node20.ok && node20.warn);
  assert.match(node20.detail, /end of life/i);
  for (const v of ['18.20.0', '19.9.0', '25.0.0', '26.1.0']) assert.ok(!checkNodeVersion(v).ok, v);
  assert.ok(!checkNodeVersion('garbage').ok);
});

test('findDeploymentByWorkspace matches by workspace id, not by registry key', () => {
  const registry = { deployments: { 'some-workspace-name': { fabricWorkspaceId: WS, itemName: 'x', fabricItemId: 'i' } }, active: 'some-workspace-name' };
  assert.equal(findDeploymentByWorkspace(registry, WS.toUpperCase())?.itemName, 'x');
  assert.equal(findDeploymentByWorkspace(registry, '11111111-1111-1111-1111-111111111111'), undefined);
  assert.equal(findDeploymentByWorkspace(undefined, WS), undefined);
  assert.equal(findDeploymentByWorkspace({}, WS), undefined);
});

test('itemNameArgs only names the item for a workspace without a recorded deployment', () => {
  assert.deepEqual(itemNameArgs(undefined), ['--item-name', APP_ITEM_NAME]);
  assert.deepEqual(itemNameArgs({ itemName: 'ai-readiness-cockpit' }), []);
});

test('pickExistingAppName reuses an app already in the workspace, preferring the new name', () => {
  const legacy = { type: 'AppBackend', displayName: 'ai-readiness-cockpit' };
  const current = { type: 'AppBackend', displayName: 'Fabric Weave' };
  assert.equal(pickExistingAppName([legacy]), 'ai-readiness-cockpit');
  assert.equal(pickExistingAppName([legacy, current]), 'Fabric Weave');
  assert.equal(pickExistingAppName([{ type: 'Notebook', displayName: 'Fabric Weave' }]), undefined);
  assert.equal(pickExistingAppName([]), undefined);
});

const item = (type, displayName, id = `${type}-${displayName}`) => ({ id, type, displayName, description: managedDescription('1.0.0') });
const bare = (type, displayName, id = `${type}-${displayName}`) => ({ id, type, displayName });
const userItem = (type, displayName) => ({ id: `${type}-${displayName}`, type, displayName });
const fullWorkspace = [
  item('AppBackend', 'ai-readiness-cockpit'),
  item('SQLDatabase', 'ai-readiness-cockpit'),
  item('SQLEndpoint', 'ai-readiness-cockpit'),
  item('UserDataFunction', 'ai-readiness-cockpit'),
  item('Lakehouse', 'AIReadiness_LH'),
  item('SQLEndpoint', 'AIReadiness_LH'),
  item('Notebook', 'NB_01_Scan_Inventory'),
  item('Notebook', 'NB_02_Usage'),
  item('Notebook', 'NB_03_Quick_Score'),
  item('DataPipeline', 'PL_AI_Readiness_Refresh'),
  userItem('SemanticModel', 'Sales (AI-ready)'),
  userItem('SemanticModel', 'Finance'),
  userItem('Notebook', 'My own notebook'),
  userItem('Lakehouse', 'Bronze'),
  userItem('SQLDatabase', 'Customer DB'),
];

test('managed marker: written, recognised, and versioned', () => {
  assert.equal(managedDescription('1.2.3'), 'Fabric Weave v1.2.3 (managed)');
  assert.equal(managedDescription('1.2.3', 'Pipeline.'), 'Fabric Weave v1.2.3 (managed). Pipeline.');
  assert.ok(isManagedItem({ description: managedDescription('1.0.0', 'x') }));
  assert.equal(managedVersion({ description: managedDescription('1.0.0-rc.1') }), '1.0.0-rc.1');
  for (const description of [undefined, '', 'Fabric Weave notebook', 'my Fabric Weave v1.0.0 (managed)', 'fabric weave v1.0.0 (managed)']) {
    assert.ok(!isManagedItem({ description }), String(description));
  }
});

test('classifyItems removes only Fabric Weave items and keeps everything else', () => {
  const { remove, keep, unmanaged } = classifyItems(fullWorkspace);
  assert.equal(remove.length, 10);
  assert.equal(unmanaged.length, 0);
  assert.deepEqual(keep.map((i) => i.displayName).sort(), ['Bronze', 'Customer DB', 'Finance', 'My own notebook', 'Sales (AI-ready)']);
});

test('classifyItems keeps an item that only has the right name, and reports it as unmanaged', () => {
  const items = [item('Notebook', 'NB_01_Scan_Inventory'), bare('Notebook', 'NB_02_Usage'), { ...bare('Notebook', 'NB_03_Quick_Score'), description: 'written by a colleague' }];
  const { remove, keep, unmanaged } = classifyItems(items);
  assert.deepEqual(remove.map((i) => i.displayName), ['NB_01_Scan_Inventory']);
  assert.deepEqual(unmanaged.map((i) => i.displayName), ['NB_02_Usage', 'NB_03_Quick_Score']);
  assert.equal(keep.length, 2);
});

test('classifyItems treats ids in the local manifest, and the recorded app item, as ours without a marker', () => {
  const items = [bare('Notebook', 'NB_01_Scan_Inventory', 'AAA'), bare('Lakehouse', 'AIReadiness_LH', 'bbb'), bare('Notebook', 'NB_02_Usage', 'ccc')];
  const { remove, unmanaged } = classifyItems(items, { manifestIds: ['aaa', 'BBB'] });
  assert.deepEqual(remove.map((i) => i.id).sort(), ['AAA', 'bbb']);
  assert.deepEqual(unmanaged.map((i) => i.id), ['ccc']);
});

test('classifyItems --include-unmarked removes name matches too, and flags them', () => {
  const items = [item('Notebook', 'NB_01_Scan_Inventory'), bare('Notebook', 'NB_02_Usage'), bare('SemanticModel', 'Finance')];
  const { remove, unmanaged, keep } = classifyItems(items, { includeUnmarked: true });
  assert.deepEqual(remove.map((i) => [i.displayName, Boolean(i.unmarked)]).sort(), [['NB_01_Scan_Inventory', false], ['NB_02_Usage', true]]);
  assert.equal(unmanaged.length, 0);
  assert.deepEqual(keep.map((i) => i.displayName), ['Finance']);
});

test('classifyItems: the app database and SQL endpoint follow the app item, not the name alone', () => {
  const unmarkedApp = [bare('AppBackend', 'Fabric Weave', 'app'), bare('SQLDatabase', 'Fabric Weave'), bare('SQLEndpoint', 'Fabric Weave')];
  assert.equal(classifyItems(unmarkedApp).remove.length, 0);
  assert.equal(classifyItems(unmarkedApp).unmanaged.length, 3);
  assert.equal(classifyItems(unmarkedApp, { appItemId: 'APP' }).remove.length, 3);
  const lakehouse = [bare('Lakehouse', 'AIReadiness_LH', 'lh'), bare('SQLEndpoint', 'AIReadiness_LH')];
  assert.equal(classifyItems(lakehouse).remove.length, 0);
  assert.equal(classifyItems(lakehouse, { manifestIds: ['lh'] }).remove.length, 2);
});

test('classifyItems orders the removal: app first, lakehouse last', () => {
  const { remove } = classifyItems(fullWorkspace);
  const groups = remove.map((i) => i.group);
  assert.equal(groups[0], 'app');
  assert.equal(remove[0].type, 'AppBackend');
  assert.equal(groups.at(-1), 'lakehouse');
  assert.ok(groups.indexOf('pipeline') < groups.indexOf('notebook'));
  assert.ok(groups.lastIndexOf('notebook') < groups.indexOf('lakehouse'));
});

test('classifyItems flags SQL endpoints as cascade deletes', () => {
  const { remove } = classifyItems(fullWorkspace);
  const endpoints = remove.filter((i) => i.type === 'SQLEndpoint');
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints.every((i) => i.cascade));
  assert.ok(remove.filter((i) => i.type !== 'SQLEndpoint').every((i) => !i.cascade));
});

test('classifyItems matches the app by its recorded id even under another name', () => {
  const renamed = [{ id: 'abc', type: 'AppBackend', displayName: 'Weave (prod)' }];
  assert.equal(classifyItems(renamed).remove.length, 0);
  assert.equal(classifyItems(renamed, { appItemId: 'ABC' }).remove.length, 1);
});

test('classifyItems never matches a user item that only shares a type', () => {
  const { remove, unmanaged } = classifyItems([userItem('SQLDatabase', 'Orders'), userItem('Lakehouse', 'AIReadiness_LH_copy'), userItem('Notebook', 'NB_01_Scan_Inventory_old')]);
  assert.equal(remove.length, 0);
  assert.equal(unmanaged.length, 0);
});

test('describeWorkspaceContents tells empty, installed, unmanaged and foreign workspaces apart', () => {
  assert.deepEqual(describeWorkspaceContents([]), { empty: true, hasApp: false, hasBackend: false, installed: false, unmanaged: [] });
  assert.ok(describeWorkspaceContents(fullWorkspace).installed);
  const foreign = describeWorkspaceContents([userItem('Lakehouse', 'Bronze')]);
  assert.ok(!foreign.empty && !foreign.installed && foreign.unmanaged.length === 0);
  const lookalike = describeWorkspaceContents([bare('Notebook', 'NB_01_Scan_Inventory')]);
  assert.ok(!lookalike.installed);
  assert.equal(lookalike.unmanaged.length, 1);
});

test('decideAdoption: create, update ours, refuse a stranger, adopt only when told or for a known legacy install', () => {
  const stranger = { id: 'n1', type: 'Notebook', displayName: 'NB_01_Scan_Inventory', description: 'mine' };
  assert.deepEqual(decideAdoption(undefined), { action: 'create' });
  assert.equal(decideAdoption(item('Notebook', 'NB_01_Scan_Inventory')).action, 'update');
  assert.equal(decideAdoption(stranger, { knownIds: ['N1'] }).action, 'update');
  const refused = decideAdoption(stranger);
  assert.equal(refused.action, 'refuse');
  assert.match(refused.reason, /--adopt/);
  assert.match(refused.reason, /Notebook "NB_01_Scan_Inventory"/);
  assert.equal(decideAdoption(stranger, { adopt: true }).action, 'adopt');
  const legacy = decideAdoption(stranger, { legacy: true });
  assert.equal(legacy.action, 'adopt');
  assert.match(legacy.reason, /predates item stamping/);
});

test('checkCapacity accepts running F2+, P1+ and trial; rejects paused, tiny or missing', () => {
  const cap = (sku, state = 'Active') => ({ displayName: 'cap', sku, state });
  for (const sku of ['F2', 'F8', 'F64', 'P1', 'P3', 'FT1']) assert.ok(checkCapacity(cap(sku)).ok, sku);
  assert.ok(checkCapacity({ displayName: 'Trial-2026', sku: 'FT1', state: 'Active' }).ok);
  assert.ok(!checkCapacity(cap('F64', 'Paused')).ok);
  assert.ok(!checkCapacity(cap('F64', 'Inactive')).ok);
  assert.ok(!checkCapacity(cap('F1')).ok);
  assert.ok(!checkCapacity(cap('A1')).ok);
  assert.ok(!checkCapacity(undefined).ok);
});

test('checkAoaiEndpoint accepts Azure endpoints, skips when empty, rejects the rest', () => {
  assert.ok(checkAoaiEndpoint('https://my-res.openai.azure.com').ok);
  assert.ok(checkAoaiEndpoint('https://my-res.cognitiveservices.azure.com/').ok);
  assert.ok(checkAoaiEndpoint('https://my-res.services.ai.azure.com').ok);
  assert.ok(checkAoaiEndpoint('').skipped);
  assert.ok(!checkAoaiEndpoint('http://my-res.openai.azure.com').ok);
  assert.ok(!checkAoaiEndpoint('https://api.openai.com').ok);
  assert.ok(!checkAoaiEndpoint('nope').ok);
});

test('checkWorkspaceRole: Admin and Member pass, Contributor warns, Viewer fails', () => {
  assert.deepEqual([checkWorkspaceRole('Admin').ok, checkWorkspaceRole('Member').ok], [true, true]);
  assert.ok(!checkWorkspaceRole('Admin').warn);
  const contributor = checkWorkspaceRole('Contributor');
  assert.ok(contributor.ok && contributor.warn);
  assert.ok(!checkWorkspaceRole('Viewer').ok);
  assert.ok(!checkWorkspaceRole(undefined).ok);
});

test('resolveRoleFromAssignments picks the strongest direct role and flags group-only access', () => {
  const me = 'AAAA-1';
  const user = (id, role) => ({ role, principal: { id, type: 'User' } });
  const group = (role) => ({ role, principal: { id: 'g1', type: 'Group' } });
  assert.deepEqual(resolveRoleFromAssignments([user('aaaa-1', 'Contributor'), user('aaaa-1', 'Admin'), user('other', 'Admin')], me), { role: 'Admin', viaGroup: false });
  assert.deepEqual(resolveRoleFromAssignments([group('Admin'), user('other', 'Member')], me), { role: undefined, viaGroup: true });
  assert.deepEqual(resolveRoleFromAssignments([], me), { role: undefined, viaGroup: false });
  assert.deepEqual(resolveRoleFromAssignments(undefined, me), { role: undefined, viaGroup: false });
});

test('readJwtClaims decodes the payload and survives garbage', () => {
  const token = `h.${Buffer.from(JSON.stringify({ oid: 'abc' })).toString('base64url')}.s`;
  assert.equal(readJwtClaims(token).oid, 'abc');
  assert.deepEqual(readJwtClaims('garbage'), {});
});

test('removeDeploymentByWorkspace drops the record and repairs the active pointer', () => {
  const registry = {
    deployments: { a: { fabricWorkspaceId: WS }, b: { fabricWorkspaceId: '11111111-1111-1111-1111-111111111111' } },
    active: 'a',
  };
  const { registry: next, removed } = removeDeploymentByWorkspace(registry, WS);
  assert.deepEqual(removed, ['a']);
  assert.deepEqual(Object.keys(next.deployments), ['b']);
  assert.equal(next.active, 'b');
  assert.ok('a' in registry.deployments, 'input is not mutated');

  const only = removeDeploymentByWorkspace({ deployments: { a: { fabricWorkspaceId: WS } }, active: 'a' }, WS).registry;
  assert.deepEqual(only.deployments, {});
  assert.ok(!('active' in only));

  assert.deepEqual(removeDeploymentByWorkspace(registry, '22222222-2222-2222-2222-222222222222').removed, []);
});

const YML = ['services:', '  auth:', '    allowedRedirectUris:', '      - http://localhost:5173', '      - http://127.0.0.1:5173', '  data:', '    enabled: true', ''];

test('ensureRedirectUri appends once, keeps indentation and line endings', () => {
  const url = 'https://contoso-app.webapp.fabricapps.net';
  const first = ensureRedirectUri(YML.join('\n'), url);
  assert.ok(first.changed);
  assert.ok(first.text.includes(`      - http://127.0.0.1:5173\n      - ${url}\n  data:`));
  assert.ok(!ensureRedirectUri(first.text, url).changed);
  const crlf = ensureRedirectUri(YML.join('\r\n'), url);
  assert.ok(crlf.text.includes(`5173\r\n      - ${url}\r\n  data:`));
  assert.ok(!ensureRedirectUri('services: {}\n', url).changed);
});

test('parseFlags reads values and booleans and reports unknown arguments', () => {
  const spec = { workspace: 'string', 'dry-run': 'boolean' };
  assert.deepEqual(parseFlags(['--workspace', WS, '--dry-run'], spec), { flags: { workspace: WS, 'dry-run': true }, unknown: [] });
  assert.deepEqual(parseFlags(['--wat'], spec).unknown, ['--wat']);
  assert.deepEqual(parseFlags(['--workspace'], spec).unknown, ['--workspace (needs a value)']);
  assert.deepEqual(parseFlags(['--workspace', '--dry-run'], spec).unknown, ['--workspace (needs a value)']);
  assert.deepEqual(parseFlags(['stray'], spec).unknown, ['stray']);
});

test('findPrivateLockfileHosts flags anything that is not the public npm registry', () => {
  const ok = '{"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}';
  const bad = `${ok}{"resolved": "https://ms-feed-25.pkgs.visualstudio.com/x"}{"resolved": "https://npm.pkg.github.com/y"}`;
  assert.deepEqual(findPrivateLockfileHosts(ok), []);
  assert.deepEqual(findPrivateLockfileHosts(bad).sort(), ['ms-feed-25.pkgs.visualstudio.com', 'npm.pkg.github.com']);
});

test('the committed app lockfile only resolves from the public npm registry', () => {
  const lock = readFileSync(new URL('../../app/package-lock.json', import.meta.url), 'utf8');
  assert.deepEqual(findPrivateLockfileHosts(lock), []);
});
