import { getRule } from '@rayfin-app/engine';

import type { Assessment } from '@/lib/api';

type Score = Assessment['score'];
export type Finding = Score['findings'][number];

export interface RuleGroup {
  key: string;
  title: string;
  severity: string;
  rationale: string;
  remediation: string;
  count: number;
  items: Finding[];
}

export interface CategoryGroup {
  id: string;
  title: string;
  score: number;
  weight: number;
  pointsLost: number;
  count: number;
  /** Findings per severity, most severe first. */
  severities: { severity: string; count: number }[];
  rules: RuleGroup[];
}

export const severityRank: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };

/** Findings per severity across rule groups, most severe first; severities with no findings are left out. */
export function severityCounts(rules: Pick<RuleGroup, 'severity' | 'count'>[]): { severity: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rules) counts.set(r.severity, (counts.get(r.severity) ?? 0) + r.count);
  return [...counts.entries()]
    .map(([severity, count]) => ({ severity, count }))
    .sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9));
}

/**
 * Groups findings by readiness category, then by what is wrong inside each category.
 * Categories that cost the most points come first, because that is where the work pays off.
 * Rule ids are only used to look things up; they are never shown to the user.
 */
export function groupFindingsByCategory(score: Score): CategoryGroup[] {
  const byRule = new Map<string, Finding[]>();
  for (const f of score.findings) byRule.set(f.ruleId, [...(byRule.get(f.ruleId) ?? []), f]);

  const groups = new Map<string, CategoryGroup>();
  const categoryOf = (id: string) => {
    let group = groups.get(id);
    if (!group) {
      const meta = score.categories.find((c) => c.id === id);
      group = {
        id,
        title: meta?.title ?? 'Other',
        score: meta?.score ?? 0,
        weight: meta?.weight ?? 0,
        pointsLost: meta ? Math.max(0, meta.weight - meta.points) : 0,
        count: 0,
        severities: [],
        rules: [],
      };
      groups.set(id, group);
    }
    return group;
  };

  for (const [ruleId, items] of byRule) {
    const rule = getRule(ruleId);
    const category = categoryOf(rule?.category ?? 'other');
    const reported = score.rules.find((r) => r.ruleId === ruleId)?.findingCount ?? 0;
    const count = Math.max(items.length, reported);
    category.rules.push({
      key: ruleId,
      title: rule?.title ?? 'Other findings',
      severity: rule?.severity ?? 'info',
      rationale: rule?.rationale ?? '',
      remediation: rule?.remediation ?? '',
      count,
      items,
    });
    category.count += count;
  }

  const order = new Map<string, number>(score.categories.map((c, i) => [c.id, i]));
  for (const group of groups.values()) {
    group.rules.sort((a, b) => (severityRank[a.severity] ?? 9) - (severityRank[b.severity] ?? 9) || b.count - a.count);
    group.severities = severityCounts(group.rules);
  }
  return [...groups.values()].sort(
    (a, b) => b.pointsLost - a.pointsLost || (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99),
  );
}

/** Readiness categories a fix proposal improves, by display name. */
export function proposalCategories(ruleIds: string[], categories: { id: string; title: string }[]): string[] {
  const titles: string[] = [];
  for (const id of ruleIds) {
    const category = getRule(id)?.category;
    const title = category ? categories.find((c) => c.id === category)?.title : undefined;
    if (title && !titles.includes(title)) titles.push(title);
  }
  return titles;
}
