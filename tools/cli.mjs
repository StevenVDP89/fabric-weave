#!/usr/bin/env node
// Fabric Weave CLI: score and fix semantic models from a terminal.
// Auth: uses the signed-in Azure CLI identity (az login). No secrets are stored.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineUrl = new URL('../app/packages/engine/dist/index.js', import.meta.url);
const { FabricClient, applyProposals, proposeFixes, scoreModel, buildSnapshot, sloppySalesModel, AzureOpenAiClient } = await import(engineUrl.href);

const RESOURCES = {
  fabric: 'https://api.fabric.microsoft.com',
  powerbi: 'https://analysis.windows.net/powerbi/api',
  cognitive: 'https://cognitiveservices.azure.com',
};
const cache = new Map();
function getToken(audience) {
  const hit = cache.get(audience);
  if (hit && hit.exp > Date.now() + 120_000) return Promise.resolve(hit.token);
  const raw = execFileSync('az', ['account', 'get-access-token', '--resource', RESOURCES[audience], '-o', 'json'], {
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const j = JSON.parse(raw);
  cache.set(audience, { token: j.accessToken, exp: new Date(j.expiresOn).getTime() || Date.now() + 3_000_000 });
  return Promise.resolve(j.accessToken);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.fromEntries(
  rest.flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]] : [])),
);

const client = new FabricClient({ getToken });
const bar = (s) => '#'.repeat(Math.round(s / 5)).padEnd(20, '.');

function printScore(name, r) {
  console.log(`\n${name}: ${r.score}/100  [${r.tier}]${r.gates.some((g) => g.triggered) ? '  (capped by a gate)' : ''}`);
  for (const c of r.categories) console.log(`  ${c.id.padEnd(13)} ${bar(c.score)} ${String(c.score).padStart(5)}`);
}

async function pickModels() {
  const all = await client.listSemanticModels(args.workspace);
  return args.model ? all.filter((m) => m.displayName.toLowerCase() === String(args.model).toLowerCase()) : all;
}

function makeLlm() {
  if (!process.env.AOAI_ENDPOINT || !process.env.AOAI_DEPLOYMENT) return undefined;
  return new AzureOpenAiClient({
    endpoint: process.env.AOAI_ENDPOINT,
    deployment: process.env.AOAI_DEPLOYMENT,
    ...(process.env.AOAI_KEY ? { apiKey: process.env.AOAI_KEY } : { getToken: () => getToken('cognitive') }),
  });
}

switch (cmd) {
  case 'deploy-sample': {
    const name = String(args.name ?? 'Sloppy Sales (demo)');
    const existing = (await client.listSemanticModels(args.workspace)).find((m) => m.displayName === name);
    if (existing) {
      console.log(`Already exists: ${existing.id}`);
      break;
    }
    const m = await client.createSemanticModel(args.workspace, name, sloppySalesModel(), 'Deliberately unprepared sample for the Fabric Weave demo.');
    console.log(`Created ${m.displayName} (${m.id})`);
    break;
  }
  case 'score': {
    for (const m of await pickModels()) {
      try {
        const parts = await client.getDefinition(args.workspace, m.id);
        printScore(m.displayName, scoreModel(buildSnapshot(parts, { name: m.displayName })));
      } catch (e) {
        console.log(`\n${m.displayName}: could not read definition (${String(e.message).slice(0, 160)})`);
      }
    }
    break;
  }
  case 'fix': {
    const [m] = await pickModels();
    if (!m) throw new Error('Model not found; pass --model "<name>"');
    const parts = await client.getDefinition(args.workspace, m.id);
    const out = await proposeFixes({ parts, name: m.displayName, llm: makeLlm() });
    printScore(`${m.displayName} (before)`, out.score);
    console.log('\nProposals:');
    for (const p of out.proposals) console.log(`  +${String(p.estimatedGain).padStart(5)}  ${p.title.padEnd(40)} ${p.changes.length} change(s) [${p.generatedBy}]`);
    for (const n of out.notes) console.log(`  note: ${n}`);
    if (!args.apply) {
      console.log('\nDry run. Re-run with --apply to write the changes back (a snapshot is saved to tools/snapshots first).');
      break;
    }
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'snapshots');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${m.displayName.replace(/\W+/g, '_')}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(parts, null, 2));
    console.log(`\nSnapshot saved: ${file}`);
    const applied = applyProposals({ parts, name: m.displayName }, out.proposals);
    console.log(`Applying ${applied.applied.length} change(s), ${applied.skipped.length} skipped...`);
    await client.updateDefinition(args.workspace, m.id, applied.parts);
    const reread = await client.getDefinition(args.workspace, m.id);
    const after = scoreModel(buildSnapshot(reread, { name: m.displayName }));
    printScore(`${m.displayName} (after, re-read from Fabric)`, after);
    console.log('\nParts now stored in Fabric:');
    for (const p of Object.keys(reread).sort()) console.log(`  ${p}`);
    if (args.refresh) {
      await client.refresh(args.workspace, m.id);
      console.log(`Refresh status: ${await client.waitForRefresh(args.workspace, m.id)}`);
    }
    break;
  }
  default:
    console.log(`Usage:
  node tools/cli.mjs deploy-sample --workspace <id> [--name <name>]
  node tools/cli.mjs score         --workspace <id> [--model <name>]
  node tools/cli.mjs fix           --workspace <id> --model <name> [--apply] [--refresh]
Optional LLM: set AOAI_ENDPOINT, AOAI_DEPLOYMENT and AOAI_KEY (or sign in with az).`);
}
