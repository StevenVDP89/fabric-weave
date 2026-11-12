import assert from 'node:assert/strict';
import test from 'node:test';
import { FabricClient } from '../dist/index.js';

const FABRIC = 'https://api.fabric.microsoft.com/v1';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** `pages` maps a full URL to its response body; every URL asked for is recorded. */
const clientFor = (pages) => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const body = pages[String(url)];
    return body === undefined ? json({ error: 'not found' }, 404) : body instanceof Response ? body : json(body);
  };
  return { asked, client: new FabricClient({ getToken: async () => 'token', fetchImpl }) };
};

test('a person\'s model access is read from the admin API, lower-cased, and only semantic models are kept', async () => {
  const { client, asked } = clientFor({
    [`${FABRIC}/admin/users/ann%40contoso.com/access?type=SemanticModel`]: {
      accessEntities: [
        { id: 'AAAA-1', displayName: 'Sales', itemAccessDetails: { type: 'SemanticModel', permissions: ['Read', 'Write', 'ReShare'] } },
        { id: 'BBBB-2', itemAccessDetails: { permissions: ['Read'] } },
        { id: 'CCCC-3', displayName: 'A report', itemAccessDetails: { type: 'Report', permissions: ['Read'] } },
        { displayName: 'No id' },
      ],
    },
  });
  const models = await client.listUserModelAccess('ann@contoso.com');
  assert.deepEqual(models, [
    { id: 'aaaa-1', displayName: 'Sales', permissions: ['read', 'write', 'reshare'] },
    { id: 'bbbb-2', displayName: 'BBBB-2', permissions: ['read'] },
  ]);
  assert.equal(asked.length, 1);
});

test('admin lists follow the next-page link while it stays on the Fabric API host', async () => {
  const next = `${FABRIC}/admin/items?type=SemanticModel&continuationToken=abc`;
  const { client, asked } = clientFor({
    [`${FABRIC}/admin/items?type=SemanticModel`]: { itemEntities: [{ id: 'M1', name: 'One', workspaceId: 'W1' }], continuationUri: next },
    [next]: { itemEntities: [{ id: 'M2', name: 'Two', workspaceId: 'W2' }, { id: 'M3', name: 'No workspace' }] },
  });
  const models = await client.listTenantModels();
  assert.deepEqual(models, [
    { id: 'm1', name: 'One', workspaceId: 'w1' },
    { id: 'm2', name: 'Two', workspaceId: 'w2' },
  ]);
  assert.deepEqual(asked, [`${FABRIC}/admin/items?type=SemanticModel`, next]);
});

test('a next-page link that points somewhere else is never followed', async () => {
  const { client, asked } = clientFor({
    [`${FABRIC}/admin/items?type=SemanticModel`]: { itemEntities: [{ id: 'M1', name: 'One', workspaceId: 'W1' }], continuationUri: 'https://evil.example.com/steal?x=1' },
  });
  const models = await client.listTenantModels();
  assert.equal(models.length, 1);
  assert.deepEqual(asked, [`${FABRIC}/admin/items?type=SemanticModel`]);

  const lookalike = clientFor({
    [`${FABRIC}/admin/items?type=SemanticModel`]: { itemEntities: [], continuationUri: 'https://api.fabric.microsoft.com.evil.example.com/v1/x' },
  });
  await lookalike.client.listTenantModels();
  assert.equal(lookalike.asked.length, 1);
});

test('an admin list that never ends is cut off', async () => {
  let n = 0;
  const fetchImpl = async () => json({ itemEntities: [{ id: `m${n}`, name: 'x', workspaceId: 'w' }], continuationUri: `${FABRIC}/admin/items?type=SemanticModel&page=${++n}` });
  const models = await new FabricClient({ getToken: async () => 't', fetchImpl }).listTenantModels();
  assert.equal(models.length, 100);
});

test('workspace role assignments give the person, the kind of principal and the role, lower-cased', async () => {
  const { client } = clientFor({
    [`${FABRIC}/workspaces/w1/roleAssignments`]: {
      value: [
        { id: 'ra1', principal: { id: 'AAA-1', type: 'User', userDetails: { userPrincipalName: 'Ann@Contoso.com' } }, role: 'Admin' },
        { id: 'ra2', principal: { id: 'GGG-2', type: 'Group' }, role: 'Contributor' },
        { id: 'ra3', principal: { type: 'User' }, role: 'Viewer' },
        { id: 'ra4', principal: { id: 'DDD-4', type: 'User' } },
      ],
    },
  });
  assert.deepEqual(await client.listWorkspaceRoleAssignments('w1'), [
    { principalId: 'aaa-1', principalType: 'User', userPrincipalName: 'ann@contoso.com', role: 'Admin' },
    { principalId: 'ggg-2', principalType: 'Group', role: 'Contributor' },
  ]);
});

test('a refused admin call surfaces as an error carrying the status', async () => {
  const { client } = clientFor({ [`${FABRIC}/admin/items?type=SemanticModel`]: new Response('{"errorCode":"Unauthorized"}', { status: 403 }) });
  await assert.rejects(client.listTenantModels(), (e) => e.status === 403);
});
