// Regenerates backend/tests/fixtures/golden_ts_scores.json from the scanner-shaped fixtures in
// backend/tests/fixtures/scanner_models.json using the TypeScript engine (the source of truth).
// Run from the repo root after `npm run build -w @rayfin-app/engine` (or `npm test -w @rayfin-app/engine`):
//   node app/packages/engine/scripts/golden-parity.mjs
import { writeFileSync } from 'node:fs';
import { GOLDEN_PATH, computeGolden, readFixtures } from './golden-lib.mjs';

const golden = computeGolden(readFixtures());
writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + '\n');
console.log(`Wrote golden scores for ${Object.keys(golden.models).length} model(s) (catalog ${golden.catalogVersion}) to ${GOLDEN_PATH}`);
