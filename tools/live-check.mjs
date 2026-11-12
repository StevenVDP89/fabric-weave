#!/usr/bin/env node
// Calls the DEPLOYED Rayfin functions as the signed-in `az` user (direct Entra exchange).
// Usage: node tools/live-check.mjs <command> [args]
//   status | portfolio | workspaces | models <ws> | assess <ws> <model> [--judge]
//   proposals <ws> <model> [--ai] | agents <ws> <model> | context <ws> <model>
// Requires: rayfin/.env (written by `rayfin up`) and externalEntraExchange enabled.
// Auth: the exchange needs a DELEGATED user token that carries the Power BI `Item.Execute.All` scope.
// The Azure CLI app is not pre-authorised for that scope, so pass one in ENTRA_TOKEN (for example from an app
// registration you own with that delegated permission). Without ENTRA_TOKEN this falls back to `az`,
// which Rayfin rejects with AUTH_FAILED; use the browser sign-in of the deployed app instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..', 'app');
const require = createRequire(resolve(appRoot, 'package.json'));

function readEnv() {
  const text = readFileSync(resolve(appRoot, 'rayfin', '.env'), 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function azToken(resource) {
  const az = process.platform === 'win32' ? 'az.cmd' : 'az';
  return execFileSync(az, ['account', 'get-access-token', '--resource', resource, '--query', 'accessToken', '-o', 'tsv'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }).trim();
}

export async function connect() {
  const env = readEnv();
  const baseUrl = env.RAYFIN_PUBLIC_API_URL;
  const publishableKey = env.RAYFIN_PUBLIC_PUBLISHABLE_KEY;
  if (!baseUrl || !publishableKey) throw new Error('rayfin/.env is missing the API URL or publishable key. Run `rayfin up` first.');
  const { RayfinClient } = await import(pathToFileURL(require.resolve('@microsoft/rayfin-client')).href);
  const { signInWithEntraToken } = await import(pathToFileURL(require.resolve('@microsoft/rayfin-auth-provider-fabric')).href);
  const client = new RayfinClient({ baseUrl, publishableKey, authStorage: false });
  const entraToken = process.env.ENTRA_TOKEN?.trim() || azToken('https://analysis.windows.net/powerbi/api');
  const session = await signInWithEntraToken(client.auth, { entraToken });
  if (!session.isAuthenticated) throw new Error('Direct Entra sign-in did not authenticate.');
  return { client, session };
}

const LONG = { timeoutMs: 240_000 };

async function main() {
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  const flags = new Set([a, b, ...rest].filter((x) => x?.startsWith('--')));
  const { client, session } = await connect();
  const f = client.functions;
  let result;
  switch (cmd) {
    case 'status':
      result = await f.getServiceStatus.invoke();
      break;
    case 'portfolio':
      result = await f.getPortfolio.invoke({ query: { sortBy: 'score', sortDir: 'asc', limit: 50 } });
      break;
    case 'workspaces':
      result = await f.listWorkspaces.invoke();
      break;
    case 'models':
      result = await f.listModels.invoke({ workspaceId: a }, LONG);
      break;
    case 'assess':
      result = await f.assessModel.invoke({ workspaceId: a, modelId: b, useJudge: flags.has('--judge') }, LONG);
      break;
    case 'proposals':
      result = await f.getFixProposals.invoke({ workspaceId: a, modelId: b, useAi: flags.has('--ai') }, LONG);
      break;
    case 'agents':
      result = await f.getAgentReadiness.invoke({ workspaceId: a, modelId: b }, LONG);
      break;
    case 'context':
      result = await f.draftBusinessContext.invoke({ workspaceId: a, modelId: b }, LONG);
      break;
    default:
      console.error('Unknown command. See the header of this file for usage.');
      process.exitCode = 2;
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  console.error(`(signed in as ${session.user?.email ?? session.user?.id ?? 'unknown'})`);
  client.auth.destroy?.();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`FAILED: ${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`);
    process.exit(1);
  });
}
