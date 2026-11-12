import { relativeTime, type Tone } from '@/lib/format';

/** The nightly pipeline runs once a day, so data older than a day and a half means a run was missed. */
export const STALE_AFTER_HOURS = 36;

export interface ScanInfo {
  generatedAt: string | null;
  lastRun: { status: 'Running' | 'Succeeded' | 'Failed'; stage: string | null; startedAt: string | null; error: string | null } | null;
}

export type PortfolioVisibility = 'unknown' | 'on' | 'off';

/**
 * Whether the Portfolio page exists for this install. It needs the optional estate scan, and that is only known
 * once the service status has loaded. Until then the answer is 'unknown', so the shell shows nothing for it
 * rather than a tab that then disappears. A failed status call counts as off.
 */
export function portfolioVisibility(status: { portfolio: { configured: boolean } } | undefined, statusError: unknown): PortfolioVisibility {
  if (status) return status.portfolio.configured ? 'on' : 'off';
  return statusError ? 'off' : 'unknown';
}

export interface ScanNotice {
  tone: Tone;
  title: string;
  body: string;
}

/** What to tell the user about the freshness of the portfolio scan. Null means all is well. */
export function scanNotice(info: ScanInfo, now: number = Date.now()): ScanNotice | null {
  const scores = info.generatedAt ? `The scores below are from ${relativeTime(info.generatedAt)}.` : 'There are no scores from an earlier scan.';
  const run = info.lastRun;
  if (run?.status === 'Failed') {
    return {
      tone: 'danger',
      title: 'The last scan failed',
      body: `${run.stage ? `It stopped at the ${run.stage} step. ` : ''}${run.error ?? 'No reason was recorded.'} ${scores} Fix the cause and run the PL_AI_Readiness_Refresh pipeline again.`,
    };
  }
  if (run?.status === 'Running') {
    return { tone: 'info', title: 'A scan is running', body: `${run.startedAt ? `It started ${relativeTime(run.startedAt)}. ` : ''}${scores}` };
  }
  if (info.generatedAt) {
    const age = now - new Date(info.generatedAt).getTime();
    if (Number.isFinite(age) && age > STALE_AFTER_HOURS * 3_600_000) {
      return {
        tone: 'caution',
        title: `The scan data is ${Math.floor(age / 86_400_000)} days old`,
        body: 'The nightly refresh may have stopped. Open the PL_AI_Readiness_Refresh pipeline in Fabric and check its recent runs.',
      };
    }
  }
  return null;
}
