import { CATALOG, tierFor } from '@rayfin-app/engine';

import type { ProposalSet } from '@/lib/api';

type Headline = ProposalSet['before'];

export interface LiveScore {
  score: number;
  tier: string;
  categories: { id: string; title: string; score: number }[];
  /** Points above the baseline. */
  delta: number;
  /** Share of the available improvement that the selection captures, 0 to 1. */
  progress: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Estimates the score for a subset of the proposals without another round trip.
 *
 * Each proposal was scored alone on the server. Per category, the selection takes the same share of the
 * category's total improvement as it holds of the proposals' stand-alone gains; the overall score then moves
 * by the same weighted share. That keeps the two ends exact (nothing selected is the baseline, everything
 * selected is the projected score) and makes every tick raise the score, even when proposals overlap.
 * The real score is always re-checked against Fabric after writing.
 */
export function liveScore(
  before: Headline,
  projected: Headline,
  impacts: ProposalSet['impacts'],
  selected: ReadonlySet<string>,
): LiveScore {
  const chosen = impacts.filter((i) => selected.has(i.proposalId));
  const positive = (n: number) => Math.max(0, n);

  let weightedLive = 0;
  let weightedTotal = 0;
  const categories = before.categories.map((c) => {
    const target = projected.categories.find((p) => p.id === c.id)?.score ?? c.score;
    const total = positive(target - c.score);
    const all = impacts.reduce((sum, i) => sum + positive(i.categories.find((x) => x.id === c.id)?.gain ?? 0), 0);
    const mine = chosen.reduce((sum, i) => sum + positive(i.categories.find((x) => x.id === c.id)?.gain ?? 0), 0);
    const share = all > 0 ? Math.min(1, mine / all) : impacts.length > 0 ? chosen.length / impacts.length : 0;
    const weight = CATALOG.categories[c.id as keyof typeof CATALOG.categories]?.weight ?? 0;
    weightedTotal += weight * total;
    weightedLive += weight * total * share;
    return { id: c.id, title: c.title, score: round1(clamp(c.score + total * share, 0, 100)) };
  });

  const totalGain = positive(projected.score - before.score);
  let progress = weightedTotal > 0 ? weightedLive / weightedTotal : 0;
  if (weightedTotal <= 0 && totalGain > 0) {
    // A gain that no category explains (for example a lifted score cap): fall back to the overall gains.
    const all = impacts.reduce((sum, i) => sum + positive(i.gain), 0);
    const mine = chosen.reduce((sum, i) => sum + positive(i.gain), 0);
    progress = all > 0 ? mine / all : 0;
  }
  progress = clamp(progress, 0, 1);

  const score = round1(clamp(before.score + totalGain * progress, 0, 100));
  return { score, tier: tierFor(score), categories, delta: round1(score - before.score), progress };
}
