import assert from 'node:assert/strict';
import test from 'node:test';
import { llmClient } from '../dist/lib/runtime.js';

const ENDPOINT = 'https://contoso-ai.openai.azure.com';

/** Calls the client against a fake fetch and returns the URL it used. */
async function urlUsed(secrets) {
  const ctx = { Secrets: secrets, Tokens: { AzureAI: 'token' }, accessToken: '' };
  const client = llmClient(ctx);
  const realFetch = globalThis.fetch;
  let seen = '';
  globalThis.fetch = async (url) => {
    seen = String(url);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), { status: 200 });
  };
  try {
    await client.complete({ system: 's', user: 'u' });
  } finally {
    globalThis.fetch = realFetch;
  }
  return seen;
}

test('the deployment name and API version come from the secrets', async () => {
  const url = await urlUsed({ AOAI_ENDPOINT: ENDPOINT, AOAI_DEPLOYMENT: 'my-gpt-5', AOAI_API_VERSION: '2025-04-01-preview' });
  assert.equal(url, `${ENDPOINT}/openai/deployments/my-gpt-5/chat/completions?api-version=2025-04-01-preview`);
});

test('defaults are gpt-4.1 and the engine API version', async () => {
  const url = await urlUsed({ AOAI_ENDPOINT: ENDPOINT });
  assert.equal(url, `${ENDPOINT}/openai/deployments/gpt-4.1/chat/completions?api-version=2024-10-21`);
});

test('a malformed API version is ignored instead of sent', async () => {
  const url = await urlUsed({ AOAI_ENDPOINT: ENDPOINT, AOAI_API_VERSION: '2025-04-01&x=1' });
  assert.match(url, /api-version=2024-10-21$/);
});

test('no endpoint, or an endpoint on another host, switches the model off', () => {
  const off = (secrets) => llmClient({ Secrets: secrets, Tokens: { AzureAI: 't' }, accessToken: '' }).name;
  assert.equal(off({}), 'unavailable');
  assert.equal(off({ AOAI_ENDPOINT: 'https://api.openai.com' }), 'unavailable');
  assert.equal(off({ AOAI_ENDPOINT: 'https://evil.example.com/.openai.azure.com' }), 'unavailable');
});
