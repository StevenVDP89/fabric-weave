import { useEffect, useState } from 'react';

import { cx } from '@/lib/cx';
import { toneBar, toneForScore, toneStroke, toneText, tierTone, formatScore, type Tone } from '@/lib/format';

const CX = 120;
const CY = 124;
const SWEEP = 270;
const START = -SWEEP / 2;

function point(radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + radius * Math.sin(rad), CY - radius * Math.cos(rad)];
}

function arc(radius: number, from: number, to: number): string {
  const [x1, y1] = point(radius, from);
  const [x2, y2] = point(radius, to);
  const large = Math.abs(to - from) > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

const angleFor = (score: number) => START + (Math.max(0, Math.min(100, score)) / 100) * SWEEP;

const ZONES: { from: number; to: number; tone: Tone }[] = [
  { from: 0, to: 40, tone: 'danger' },
  { from: 40, to: 65, tone: 'warning' },
  { from: 65, to: 85, tone: 'caution' },
  { from: 85, to: 100, tone: 'success' },
];

/**
 * Fabric Weave's signature instrument: a 270° gauge with tier zones, a swept value arc and a needle.
 * `compare` draws a hollow marker for a previous score so a before/after is readable at a glance.
 */
export function ScoreDial({
  score,
  tier,
  compare,
  caption = 'AI-readiness',
  className,
}: {
  score: number;
  tier: string;
  compare?: number | null;
  caption?: string;
  className?: string;
}) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(score));
    return () => cancelAnimationFrame(frame);
  }, [score]);

  const tone = tierTone(tier) === 'neutral' ? toneForScore(score) : tierTone(tier);
  const ticks = Array.from({ length: 21 }, (_, i) => i * 5);

  return (
    <figure className={cx('relative mx-auto w-full max-w-72', className)} aria-label={`${caption}: ${formatScore(score)} out of 100, ${tier}`}>
      <svg viewBox="0 0 240 210" role="img" aria-hidden className="w-full overflow-visible">
        {ZONES.map((z) => (
          <path
            key={z.tone}
            d={arc(106, angleFor(z.from) + 0.6, angleFor(z.to) - 0.6)}
            fill="none"
            strokeWidth={3}
            strokeLinecap="butt"
            className={cx(toneStroke[z.tone], 'opacity-60')}
          />
        ))}
        {ticks.map((v) => {
          const major = v % 25 === 0;
          const [x1, y1] = point(major ? 92 : 95, angleFor(v));
          const [x2, y2] = point(100, angleFor(v));
          return <line key={v} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={major ? 1.6 : 1} className="stroke-muted-foreground/70" />;
        })}
        {[0, 25, 50, 75, 100].map((v) => {
          const [x, y] = point(78, angleFor(v));
          return (
            <text key={v} x={x} y={y} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground font-numeric" fontSize={9}>
              {v}
            </text>
          );
        })}
        <path d={arc(86, START, START + SWEEP)} fill="none" strokeWidth={9} strokeLinecap="round" className="stroke-muted" />
        <path
          d={arc(86, START, START + SWEEP)}
          fill="none"
          strokeWidth={9}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 - shown}
          className={cx('dial-sweep', toneStroke[tone])}
        />
        {compare !== null && compare !== undefined ? (
          <circle
            cx={point(86, angleFor(compare))[0]}
            cy={point(86, angleFor(compare))[1]}
            r={6}
            strokeWidth={2.5}
            className="fill-card stroke-muted-foreground"
          >
            <title>{`Previous score ${formatScore(compare)}`}</title>
          </circle>
        ) : null}
        <g className="dial-needle" style={{ transformOrigin: `${CX}px ${CY}px`, transform: `rotate(${angleFor(shown)}deg)` }}>
          <line x1={CX} y1={CY} x2={CX} y2={CY - 70} strokeWidth={2} strokeLinecap="round" className="stroke-signal" />
          <circle cx={CX} cy={CY} r={5} className="fill-signal" />
        </g>
        <circle cx={CX} cy={CY} r={2} className="fill-card" />
      </svg>
      <figcaption className="-mt-200 text-center">
        <p className={cx('font-numeric text-hero-900 leading-hero-900 font-medium tabular-nums', toneText[tone])}>{formatScore(score)}</p>
        <p className="font-heading text-400 leading-400 font-semibold">{tier}</p>
        <p className="mt-100 font-numeric text-100 tracking-[0.14em] text-muted-foreground uppercase">{caption}</p>
      </figcaption>
    </figure>
  );
}

/** Compact score readout for dense lists: number plus a thin tier-coloured bar. */
export function ScoreChip({ score, className }: { score: number | null | undefined; className?: string }) {
  const tone = toneForScore(score);
  const pct = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  return (
    <div className={cx('flex w-28 items-center gap-200', className)}>
      <span className={cx('w-10 text-right font-numeric text-300 tabular-nums', toneText[tone])}>{formatScore(score)}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className={cx('block h-full rounded-full', toneBar[tone])} style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}

export function CategoryBars({
  categories,
  compare,
}: {
  categories: { id: string; title: string; score: number; weight?: number }[];
  compare?: { id: string; score: number }[];
}) {
  return (
    <ul className="space-y-300">
      {categories.map((c) => {
        const tone = toneForScore(c.score);
        const before = compare?.find((x) => x.id === c.id)?.score;
        return (
          <li key={c.id}>
            <div className="flex items-baseline justify-between gap-300 text-300 leading-300">
              <span className="font-medium">
                {c.title}
                {c.weight !== undefined ? <span className="ml-200 font-numeric text-200 text-muted-foreground">{c.weight} pts</span> : null}
              </span>
              <span className={cx('font-numeric tabular-nums', toneText[tone])}>
                {formatScore(c.score)}
                {before !== undefined && Math.abs(before - c.score) >= 0.05 ? (
                  <span className="ml-200 text-200 text-muted-foreground">from {formatScore(before)}</span>
                ) : null}
              </span>
            </div>
            <div className="relative mt-100 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
              <div className={cx('h-full rounded-full transition-[width] duration-700', toneBar[tone])} style={{ width: `${Math.max(0, Math.min(100, c.score))}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
