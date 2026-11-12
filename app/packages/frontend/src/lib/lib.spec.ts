import { describe, expect, it } from 'vitest';

import { describeChange, isEditable, sameChanges, splitList, targetPath, type Change } from '@/lib/changes';
import { appendContext, appendDictation, clipContext, composeContextText, CONTEXT_TEXT_MAX } from '@/lib/context';
import { collapseDiff, diffStats, lineDiff } from '@/lib/diff';
import { groupFindingsByCategory, proposalCategories, severityCounts } from '@/lib/findingGroups';
import { formatDelta, formatScore, relativeTime, tierTone, toneForScore } from '@/lib/format';
import { liveScore } from '@/lib/liveScore';
import { tierFor } from '@rayfin-app/engine';
import { hrefFor, modelHref, parseHash } from '@/lib/route';
import { describeSpeechError, isEmbedded, microphonePolicy } from '@/lib/speech';

const WS = '11111111-1111-1111-1111-111111111111';
const MODEL = '22222222-2222-2222-2222-222222222222';

describe('findingGroups', () => {
  const categories = [
    { id: 'foundation', title: 'Model foundation', weight: 25, score: 90, points: 22.5 },
    { id: 'naming', title: 'Business-friendly naming', weight: 15, score: 100, points: 15 },
    { id: 'descriptions', title: 'Descriptions', weight: 20, score: 10, points: 2 },
    { id: 'schema', title: 'AI data schema', weight: 15, score: 50, points: 7.5 },
  ];
  const finding = (ruleId: string, objectPath: string) => ({ ruleId, objectType: 'table', objectPath, message: 'm', fixKind: 'manual' });
  const score = {
    categories,
    findings: [finding('FND-004', 'dim_date'), finding('DSC-001', 'a'), finding('DSC-001', 'b'),     finding('SCH-001', 'Revenue')],
    rules: [
      { ruleId: 'FND-004', score: 0, evidence: '', findingCount: 1 },
      { ruleId: 'DSC-001', score: 0, evidence: '', findingCount: 40 },
          { ruleId: 'SCH-001', score: 0.5, evidence: '', findingCount: 1 },
    ],
  } as unknown as Parameters<typeof groupFindingsByCategory>[0];

  it('groups findings by readiness category with the biggest point loss first', () => {
    const groups = groupFindingsByCategory(score);
    expect(groups.map((g) => g.title)).toEqual(['Descriptions', 'AI data schema', 'Model foundation']);
    expect(groups[0]).toMatchObject({ id: 'descriptions', count: 40, pointsLost: 18 });
    expect(groups[0]?.rules[0]?.items).toHaveLength(2);
  });

  it('never exposes rule codes in the titles it returns', () => {
    const text = JSON.stringify(groupFindingsByCategory(score).map((g) => [g.title, g.rules.map((r) => r.title)]));
    expect(text).not.toMatch(/\b[A-Z]{3}-\d{3}\b/);
  });

  it('names the categories a proposal improves, once each, skipping gate ids', () => {
    expect(proposalCategories(['DSC-001', 'DSC-004', 'GATE-NO-MEASURES', 'NAM-002'], categories)).toEqual(['Descriptions', 'Business-friendly naming']);
  });

  it('counts findings per severity, most severe first, leaving out empty severities', () => {
    expect(severityCounts([{ severity: 'minor', count: 3 }, { severity: 'critical', count: 1 }, { severity: 'minor', count: 2 }])).toEqual([
      { severity: 'critical', count: 1 },
      { severity: 'minor', count: 5 },
    ]);
    expect(severityCounts([])).toEqual([]);
  });

  it('carries the severity counts on every category group', () => {
    const groups = groupFindingsByCategory(score);
    for (const g of groups) expect(g.severities.reduce((n, s) => n + s.count, 0)).toBe(g.count);
  });
});

describe('liveScore', () => {
  const head = (score: number, d: number, i: number) => ({
    score,
    tier: tierFor(score),
    categories: [
      { id: 'descriptions', title: 'Descriptions', score: d },
      { id: 'instructions', title: 'AI instructions', score: i },
    ],
  });
  const before = head(60, 20, 0);
  const projected = head(82, 80, 60);
  const impacts = [
    { proposalId: 'a', gain: 3, categories: [{ id: 'descriptions', gain: 3 }] },
    { proposalId: 'b', gain: 6, categories: [{ id: 'descriptions', gain: 1 }, { id: 'instructions', gain: 5 }] },
    { proposalId: 'c', gain: 5, categories: [{ id: 'instructions', gain: 5 }] },
  ];
  const live = (...ids: string[]) => liveScore(before, projected, impacts, new Set(ids));

  it('starts at the baseline when nothing is selected', () => {
    const r = live();
    expect(r.score).toBe(60);
    expect(r.delta).toBe(0);
    expect(r.progress).toBe(0);
    expect(r.categories.map((c) => c.score)).toEqual([20, 0]);
  });

  it('reaches the projected score and categories when everything is selected', () => {
    const r = live('a', 'b', 'c');
    expect(r.score).toBe(82);
    expect(r.delta).toBe(22);
    expect(r.categories.map((c) => c.score)).toEqual([80, 60]);
    expect(r.tier).toBe(tierFor(82));
  });

  it('rises with every extra proposal and never goes backwards', () => {
    const none = live().score;
    const one = live('a').score;
    const two = live('a', 'c').score;
    const all = live('a', 'b', 'c').score;
    expect(one).toBeGreaterThan(none);
    expect(two).toBeGreaterThan(one);
    expect(all).toBeGreaterThan(two);
  });

  it('moves only the categories a selected proposal improves', () => {
    const r = live('a');
    expect(r.categories[0]?.score).toBeCloseTo(65, 5);
    expect(r.categories[1]?.score).toBe(0);
  });

  it('ignores ids that are not proposals and stays within 0 to 100', () => {
    expect(live('zzz').score).toBe(60);
    const capped = liveScore(head(99, 99, 99), head(120, 120, 120), impacts, new Set(['a', 'b', 'c']));
    expect(capped.score).toBeLessThanOrEqual(100);
    expect(capped.categories.every((c) => c.score <= 100)).toBe(true);
  });

  it('falls back to the proposal count when no per-category gain was recorded', () => {
    const bare = [
      { proposalId: 'a', gain: 0, categories: [] },
      { proposalId: 'b', gain: 0, categories: [] },
    ];
    const half = liveScore(before, projected, bare, new Set(['a']));
    expect(half.categories[0]?.score).toBeCloseTo(50, 5);
  });

  it('uses the overall gains when a score cap is lifted but no category moves', () => {
    const flat = head(40, 50, 50);
    const lifted = head(60, 50, 50);
    const gates = [
      { proposalId: 'a', gain: 12, categories: [] },
      { proposalId: 'b', gain: 8, categories: [] },
    ];
    expect(liveScore(flat, lifted, gates, new Set(['a'])).score).toBe(52);
    expect(liveScore(flat, lifted, gates, new Set(['a', 'b'])).score).toBe(60);
  });

  it('reports the tier of the estimated score', () => {
    expect(live().tier).toBe('Needs work');
    expect(live('a', 'b', 'c').tier).toBe('Almost ready');
  });
});

describe('route', () => {
  it('defaults to the portfolio and parses the top-level pages', () => {
    expect(parseHash('')).toEqual({ page: 'portfolio' });
    expect(parseHash('#/models')).toEqual({ page: 'models' });
    expect(parseHash('#/workspaces')).toEqual({ page: 'workspaces' });
    expect(parseHash('#/status')).toEqual({ page: 'status' });
  });

  it('round-trips a model deep link and defaults an unknown tab to overview', () => {
    expect(parseHash(modelHref(WS, MODEL, 'fix'))).toEqual({ page: 'model', workspaceId: WS, modelId: MODEL, tab: 'fix' });
    expect(parseHash(`#/model/${WS}/${MODEL}/nonsense`)).toMatchObject({ tab: 'overview' });
    expect(hrefFor({ page: 'portfolio' })).toBe('#/portfolio');
  });

  it('rejects model links whose ids are not GUIDs', () => {
    expect(parseHash('#/model/not-a-guid/also-not')).toEqual({ page: 'models' });
    expect(parseHash(`#/model/${WS}`)).toEqual({ page: 'models' });
  });
});

describe('format', () => {
  it('maps scores and tiers to tones using the catalog thresholds', () => {
    expect(toneForScore(85)).toBe('success');
    expect(toneForScore(84.9)).toBe('caution');
    expect(toneForScore(65)).toBe('caution');
    expect(toneForScore(40)).toBe('warning');
    expect(toneForScore(39.9)).toBe('danger');
    expect(toneForScore(null)).toBe('neutral');
    expect(tierTone('AI-ready')).toBe('success');
    expect(tierTone('Not ready')).toBe('danger');
    expect(tierTone('something else')).toBe('neutral');
  });

  it('formats scores, deltas and relative dates', () => {
    expect(formatScore(97.25)).toBe('97.3');
    expect(formatScore(null)).toBe('—');
    expect(formatDelta(12.34)).toBe('+12.3');
    expect(formatDelta(-1)).toBe('−1.0');
    expect(formatDelta(0)).toBe('±0.0');
    expect(relativeTime(null)).toBe('never');
    expect(relativeTime(new Date().toISOString())).toBe('today');
    expect(relativeTime(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe('3 days ago');
  });
});

describe('diff', () => {
  it('marks added and removed lines and keeps unchanged ones', () => {
    const lines = lineDiff('a\nb\nc', 'a\nB\nc\nd');
    expect(lines.filter((l) => l.kind === 'same').map((l) => l.text)).toEqual(['a', 'c']);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('collapses long unchanged runs into a gap marker', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 15', 'line fifteen');
    const collapsed = collapseDiff(lineDiff(before, after), 2);
    expect(collapsed.some((l) => l.kind === 'gap')).toBe(true);
    expect(collapsed.length).toBeLessThan(30);
  });

  it('falls back to a set comparison for very large parts', () => {
    const big = Array.from({ length: 1600 }, (_, i) => `row ${i}`).join('\n');
    const stats = diffStats(lineDiff(big, `${big}\nextra`));
    expect(stats).toEqual({ added: 1, removed: 0 });
  });
});

describe('changes', () => {
  const describe1: Change = { op: 'setDescription', target: { type: 'column', table: 'Sales', name: 'Amount' }, value: 'Net sales amount' };
  const instructions: Change = { op: 'setInstructions', value: 'Use [Net Sales] for revenue.' };

  it('describes targets and changes', () => {
    expect(targetPath(describe1.op === 'setDescription' ? describe1.target : { type: 'table', table: '' })).toBe('Sales[Amount]');
    expect(describeChange(describe1)).toBe('Describe Sales[Amount]');
    expect(describeChange(instructions)).toBe('Write AI instructions for the model');
  });

  it('only lets reviewers edit text-like changes', () => {
    expect(isEditable(describe1)).toBe(true);
    expect(isEditable({ op: 'setHidden', target: { type: 'column', table: 'Sales', name: 'Key' }, value: true })).toBe(false);
  });

  it('compares change lists and splits comma lists', () => {
    expect(sameChanges([describe1], [{ ...describe1 }])).toBe(true);
    expect(sameChanges([describe1], [instructions])).toBe(false);
    expect(splitList(' a, b ,, c ', /,/)).toEqual(['a', 'b', 'c']);
  });
});

describe('context text', () => {
  it('turns older structured entries into one readable description', () => {
    const text = composeContextText({
      domain: 'retail sales',
      audience: 'regional managers',
      defaultTimeFrame: 'last full quarter',
      fiscalYearStart: 'July',
      preferredMeasures: ['Net revenue', ' '],
      glossary: [
        { term: 'Order', meaning: 'a completed order' },
        { term: '', meaning: 'ignored' },
      ],
      notes: 'Returns are booked in the month they arrive.',
    });
    expect(text).toContain('This model is used for retail sales.');
    expect(text).toContain('Questions come from: regional managers.');
    expect(text).toContain('Default time frame: last full quarter.');
    expect(text).toContain('The fiscal year starts in July.');
    expect(text).toContain('Preferred measures: [Net revenue].');
    expect(text).toContain('- Order: a completed order');
    expect(text).not.toContain('ignored');
    expect(text).toContain('Returns are booked in the month they arrive.');
  });

  it('is empty when nothing is filled in, and never exceeds the stored limit', () => {
    expect(composeContextText({ domain: '  ', glossary: [], preferredMeasures: [] })).toBe('');
    expect(composeContextText({ notes: 'x'.repeat(CONTEXT_TEXT_MAX + 100) })).toHaveLength(CONTEXT_TEXT_MAX);
    expect(clipContext('short')).toBe('short');
  });

  it('adds a draft after what the person wrote and never replaces it', () => {
    expect(appendContext('My own text.', 'AI draft.')).toBe('My own text.\n\nAI draft.');
    expect(appendContext('', 'AI draft.')).toBe('AI draft.');
    expect(appendContext('Mine', '   ')).toBe('Mine');
  });

  it('joins dictated phrases with exactly one space', () => {
    expect(appendDictation('', ' hello there ')).toBe('hello there');
    expect(appendDictation('First.', 'second.')).toBe('First. second.');
    expect(appendDictation('First.\n', 'second.')).toBe('First.\nsecond.');
    expect(appendDictation('First.', '   ')).toBe('First.');
  });

  it('explains speech errors in plain words and ignores a deliberate stop', () => {
    expect(describeSpeechError('aborted')).toBeNull();
    expect(describeSpeechError('not-allowed')).toMatch(/microphone/);
    expect(describeSpeechError('service-not-allowed')).toMatch(/microphone/);
    expect(describeSpeechError('no-speech')).toMatch(/did not hear/);
    expect(describeSpeechError('audio-capture')).toMatch(/No microphone/);
    expect(describeSpeechError('network')).toMatch(/speech service/);
    expect(describeSpeechError('something-new')).toMatch(/stopped unexpectedly/);
  });

  it('explains a blocked microphone in a frame as the host’s doing and points to a way out', () => {
    const framed = describeSpeechError('not-allowed', true);
    expect(framed).toMatch(/microphone/);
    expect(framed).toMatch(/own tab/);
    expect(describeSpeechError('service-not-allowed', true)).toBe(framed);
    expect(describeSpeechError('not-allowed', false)).not.toMatch(/own tab/);
    expect(describeSpeechError('no-speech', true)).toMatch(/did not hear/);
  });

  it('reads the microphone policy of the page that embeds the app', () => {
    expect(microphonePolicy({ permissionsPolicy: { allowsFeature: () => false } })).toBe('blocked');
    expect(microphonePolicy({ permissionsPolicy: { allowsFeature: (f) => f === 'microphone' } })).toBe('allowed');
    expect(microphonePolicy({ featurePolicy: { allowsFeature: () => false } })).toBe('blocked');
    expect(microphonePolicy({})).toBe('unknown');
    expect(
      microphonePolicy({
        permissionsPolicy: {
          allowsFeature: () => {
            throw new Error('nope');
          },
        },
      }),
    ).toBe('unknown');
  });

  it('tells a framed app from a top-level one', () => {
    const top = {};
    expect(isEmbedded({ self: top, top })).toBe(false);
    expect(isEmbedded({ self: {}, top: {} })).toBe(true);
    expect(
      isEmbedded({
        self: {},
        get top(): unknown {
          throw new Error('cross origin');
        },
      }),
    ).toBe(true);
    expect(isEmbedded(undefined)).toBe(false);
  });
});
