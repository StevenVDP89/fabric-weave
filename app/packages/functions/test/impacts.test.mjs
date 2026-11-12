import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProposals, buildSnapshot, proposeFixes, scoreModel, sloppySalesModel } from '@rayfin-app/engine';
import { proposalImpacts } from '../dist/lib/views.js';

const parts = sloppySalesModel();
const base = { parts, name: 'Sloppy Sales' };

async function setup() {
  const { proposals, score } = await proposeFixes(base);
  const before = score ?? scoreModel(buildSnapshot(parts, { name: base.name }));
  return { proposals, before, impacts: proposalImpacts(base, before, proposals) };
}

test('every proposal gets one impact entry, in the same order', async () => {
  const { proposals, impacts } = await setup();
  assert.deepEqual(
    impacts.map((i) => i.proposalId),
    proposals.map((p) => p.id),
  );
});

test('an impact is what the proposal is worth on its own, per category', async () => {
  const { proposals, before, impacts } = await setup();
  const first = proposals[0];
  const alone = applyProposals(base, [first]).score;
  const impact = impacts.find((i) => i.proposalId === first.id);
  assert.ok(Math.abs(impact.gain - (alone.score - before.score)) < 0.001);
  for (const c of impact.categories) {
    const was = before.categories.find((b) => b.id === c.id).score;
    const now = alone.categories.find((b) => b.id === c.id).score;
    assert.ok(Math.abs(c.gain - (now - was)) < 0.001, c.id);
  }
  assert.ok(impact.categories.every((c) => c.gain !== 0), 'categories that do not move are left out');
});

test('the impacts are enough to explain the whole improvement', async () => {
  const { proposals, before, impacts } = await setup();
  const all = applyProposals(base, proposals).score;
  const totalAlone = impacts.reduce((sum, i) => sum + Math.max(0, i.gain), 0);
  assert.ok(all.score > before.score);
  assert.ok(totalAlone > 0, 'at least one proposal improves the score on its own');
  for (const c of all.categories) {
    const moved = c.score - before.categories.find((b) => b.id === c.id).score;
    if (moved > 0.001) {
      const explained = impacts.reduce((sum, i) => sum + Math.max(0, i.categories.find((x) => x.id === c.id)?.gain ?? 0), 0);
      assert.ok(explained > 0, `${c.id} improves, so some proposal must be credited with it`);
    }
  }
});
