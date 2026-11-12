import { cx } from '@/lib/cx';

/** Fabric Weave brand mark: three interlaced ribbons on a rounded tile. */
export function WeaveMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cx('shrink-0', className)} aria-hidden focusable="false">
      <rect width="32" height="32" rx="6" className="fill-primary" />
      <g fill="none" strokeWidth="3" strokeLinecap="round">
        <path d="M6 11C10 5 14 5 16 11S22 17 26 11" opacity="0.55" className="stroke-primary-foreground" />
        <path d="M6 17C10 11 14 11 16 17S22 23 26 17" className="stroke-signal" />
        <path d="M6 23C10 17 14 17 16 23S22 29 26 23" className="stroke-primary-foreground" />
      </g>
    </svg>
  );
}
