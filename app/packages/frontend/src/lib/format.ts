export type Tone = 'success' | 'caution' | 'warning' | 'danger' | 'neutral' | 'info';

export const TIER_ORDER = ['AI-ready', 'Almost ready', 'Needs work', 'Not ready'] as const;

export function tierTone(tier: string | null | undefined): Tone {
  switch (tier) {
    case 'AI-ready':
      return 'success';
    case 'Almost ready':
      return 'caution';
    case 'Needs work':
      return 'warning';
    case 'Not ready':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function toneForScore(score: number | null | undefined): Tone {
  if (score === null || score === undefined) return 'neutral';
  if (score >= 85) return 'success';
  if (score >= 65) return 'caution';
  if (score >= 40) return 'warning';
  return 'danger';
}

export const toneText: Record<Tone, string> = {
  success: 'text-success',
  caution: 'text-caution',
  warning: 'text-warning',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
  info: 'text-primary',
};

export const toneStroke: Record<Tone, string> = {
  success: 'stroke-success',
  caution: 'stroke-caution',
  warning: 'stroke-warning',
  danger: 'stroke-destructive',
  neutral: 'stroke-muted-foreground',
  info: 'stroke-primary',
};

export const toneBar: Record<Tone, string> = {
  success: 'bg-success',
  caution: 'bg-caution',
  warning: 'bg-warning',
  danger: 'bg-destructive',
  neutral: 'bg-muted-foreground',
  info: 'bg-primary',
};

export const toneSoft: Record<Tone, string> = {
  success: 'bg-success/12 text-success border-success/30',
  caution: 'bg-caution/12 text-caution border-caution/30',
  warning: 'bg-warning/12 text-warning border-warning/30',
  danger: 'bg-destructive/12 text-destructive border-destructive/30',
  neutral: 'bg-muted text-muted-foreground border-border',
  info: 'bg-primary/10 text-primary border-primary/30',
};

export function formatScore(score: number | null | undefined): string {
  return score === null || score === undefined ? '—' : score.toFixed(1);
}

export function formatDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  return `${sign}${Math.abs(delta).toFixed(1)}`;
}

export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toLocaleString();
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return 'never';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 60) return `${days} days ago`;
  return `${Math.floor(days / 30)} months ago`;
}

export function fabricModelUrl(workspaceId: string, modelId: string): string {
  return `https://app.fabric.microsoft.com/groups/${workspaceId}/datasets/${modelId}/details?experience=power-bi`;
}
