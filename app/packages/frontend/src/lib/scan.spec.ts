import { describe, expect, it } from 'vitest';

import { portfolioVisibility, scanNotice, STALE_AFTER_HOURS } from './scan';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const run = (over: Partial<NonNullable<Parameters<typeof scanNotice>[0]['lastRun']>>) => ({ status: 'Succeeded' as const, stage: null, startedAt: null, error: null, ...over });

describe('portfolioVisibility', () => {
  it('is unknown until the status has loaded, so the tab is never shown speculatively', () => {
    expect(portfolioVisibility(undefined, undefined)).toBe('unknown');
    expect(portfolioVisibility(undefined, null)).toBe('unknown');
  });

  it('follows whether the estate scan is installed', () => {
    expect(portfolioVisibility({ portfolio: { configured: true } }, undefined)).toBe('on');
    expect(portfolioVisibility({ portfolio: { configured: false } }, undefined)).toBe('off');
  });

  it('treats a failed status call as off', () => {
    expect(portfolioVisibility(undefined, new Error('boom'))).toBe('off');
  });
});

describe('scanNotice', () => {
  it('stays quiet when the scan is recent and succeeded', () => {
    expect(scanNotice({ generatedAt: hoursAgo(5), lastRun: run({}) }, NOW)).toBeNull();
    expect(scanNotice({ generatedAt: hoursAgo(5), lastRun: null }, NOW)).toBeNull();
  });

  it('says plainly when the last scan failed, and keeps showing the older scores', () => {
    const n = scanNotice({ generatedAt: hoursAgo(30), lastRun: run({ status: 'Failed', stage: 'usage', error: 'Capacity is not active' }) }, NOW);
    expect(n?.tone).toBe('danger');
    expect(n?.body).toContain('usage step');
    expect(n?.body).toContain('Capacity is not active');
    expect(n?.body).toContain('scores below');
  });

  it('copes with a failure that left no earlier data', () => {
    const n = scanNotice({ generatedAt: null, lastRun: run({ status: 'Failed', error: null }) }, NOW);
    expect(n?.body).toContain('No reason was recorded');
    expect(n?.body).toContain('no scores from an earlier scan');
  });

  it('shows that a scan is running', () => {
    expect(scanNotice({ generatedAt: hoursAgo(20), lastRun: run({ status: 'Running', startedAt: hoursAgo(0.1) }) }, NOW)?.tone).toBe('info');
  });

  it('warns when the data is older than the nightly cadence allows, even without a failure record', () => {
    expect(scanNotice({ generatedAt: hoursAgo(STALE_AFTER_HOURS - 1), lastRun: null }, NOW)).toBeNull();
    const n = scanNotice({ generatedAt: hoursAgo(24 * 6 + 2), lastRun: null }, NOW);
    expect(n?.tone).toBe('caution');
    expect(n?.title).toContain('6 days old');
  });

  it('ignores an unreadable timestamp', () => {
    expect(scanNotice({ generatedAt: 'garbage', lastRun: null }, NOW)).toBeNull();
  });
});
