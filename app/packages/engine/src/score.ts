import { CATALOG } from './catalog.js';
import { evaluateRules, isTableInScope, type EvaluateOptions } from './rules.js';
import type { CategoryId, CategoryScore, Finding, GateResult, ModelSnapshot, ScoreResult } from './types.js';

export interface ScoreOptions extends EvaluateOptions {
  now?: Date;
}

export function tierFor(score: number): string {
  const tier = [...CATALOG.tiers].sort((a, b) => b.min - a.min).find((t) => score >= t.min);
  return tier?.label ?? 'Not ready';
}

export function scoreModel(snap: ModelSnapshot, opts: ScoreOptions = {}): ScoreResult {
  const rules = evaluateRules(snap, opts);
  const byId = new Map(rules.map((r) => [r.ruleId, r]));

  const categories: CategoryScore[] = [];
  let weightedSum = 0;
  let weightApplicable = 0;
  for (const id of Object.keys(CATALOG.categories) as CategoryId[]) {
    const meta = CATALOG.categories[id];
    let num = 0;
    let den = 0;
    for (const def of CATALOG.rules.filter((r) => r.category === id)) {
      const r = byId.get(def.id);
      if (!r || r.score === null) continue;
      num += def.weight * r.score;
      den += def.weight;
    }
    const catScore = den === 0 ? 0 : (num / den) * 100;
    if (den > 0) {
      weightedSum += meta.weight * (catScore / 100);
      weightApplicable += meta.weight;
    }
    categories.push({
      id,
      title: meta.title,
      weight: meta.weight,
      score: round1(catScore),
      points: 0,
    });
  }
  const rawScore = weightApplicable === 0 ? 0 : (weightedSum / weightApplicable) * 100;
  for (const c of categories) {
    const applicable = CATALOG.rules.some((r) => r.category === c.id && byId.get(r.id)?.score !== null);
    c.points = applicable && weightApplicable > 0 ? round1((c.weight * (c.score / 100) * 100) / weightApplicable) : 0;
  }

  const explicitMeasures = snap.tables.reduce((s, t) => s + t.measures.length, 0);
  const gates: GateResult[] = CATALOG.gates.map((g) => {
    let triggered = false;
    if (g.id === 'GATE-NO-MEASURES') triggered = explicitMeasures === 0;
    if (g.id === 'GATE-QNA-OFF') triggered = snap.governance.qnaEnabled === false;
    if (g.id === 'GATE-NO-CAPACITY') triggered = snap.governance.capacityEligible === false;
    return { id: g.id, title: g.title, cap: g.cap, triggered };
  });
  const cap = gates.filter((g) => g.triggered).reduce((m, g) => Math.min(m, g.cap), 100);
  const score = Math.min(rawScore, cap);

  const findings: Finding[] = rules.flatMap((r) => r.findings);
  const visibleTables = snap.tables.filter(isTableInScope);
  const allCols = snap.tables.flatMap((t) => t.columns);
  const allMeasures = snap.tables.flatMap((t) => t.measures);

  return {
    catalogVersion: CATALOG.version,
    mode: snap.metadataOnly ? 'quick' : 'deep',
    modelName: snap.name,
    score: round1(score),
    rawScore: round1(rawScore),
    tier: tierFor(score),
    categories,
    gates,
    rules,
    findings,
    stats: {
      tables: snap.tables.length,
      visibleTables: visibleTables.length,
      columns: allCols.length,
      visibleColumns: visibleTables.reduce((s, t) => s + t.columns.filter((c) => !c.isHidden && c.aiVisibility !== 'Hidden').length, 0),
      measures: allMeasures.length,
      visibleMeasures: visibleTables.reduce((s, t) => s + t.measures.filter((m) => !m.isHidden && m.aiVisibility !== 'Hidden').length, 0),
      relationships: snap.relationships.length,
    },
    computedAt: (opts.now ?? new Date()).toISOString(),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Points gained between two score results, per category and overall. */
export function diffScores(before: ScoreResult, after: ScoreResult) {
  return {
    overall: after.score - before.score,
    tierBefore: before.tier,
    tierAfter: after.tier,
    categories: after.categories.map((c) => ({
      id: c.id,
      before: before.categories.find((b) => b.id === c.id)?.score ?? 0,
      after: c.score,
    })),
    resolved: before.findings.length - after.findings.length,
  };
}
