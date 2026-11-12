// Writes the rule catalog the notebooks load (uploaded by backend/deploy.mjs). Run from the repo root after a build:
//   node app/packages/engine/scripts/export-catalog.mjs
// The file is written as UTF-8 without a BOM so Python's json.load reads it unchanged.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../../../backend/catalog/rule-catalog.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(CATALOG, null, 2) + '\n', 'utf8');
console.log(`Wrote ${CATALOG.rules.length} rules (catalog ${CATALOG.version}) to ${out}`);
