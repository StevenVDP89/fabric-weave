import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';

import { cx } from '@/lib/cx';
import { toneSoft, type Tone } from '@/lib/format';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const buttonBase =
  'inline-flex items-center justify-center gap-200 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border-input bg-card text-foreground hover:bg-accent',
  ghost: 'border-transparent bg-transparent text-foreground hover:bg-accent',
  danger: 'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  busy?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      className={cx(
        buttonBase,
        buttonVariants[variant],
        size === 'sm' ? 'h-8 px-300 text-200' : 'h-9 px-400 text-300',
        className
      )}
    >
      {busy ? <Loader2 className="icon-size-200 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-100 rounded-sm border px-200 py-100-nudge text-200 leading-200 font-medium whitespace-nowrap',
        toneSoft[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-lg border border-border bg-card text-card-foreground', className)}>{children}</section>;
}

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-300 border-b border-border px-500 py-400">
      <div className="min-w-0">
        <h2 className="font-heading text-400 leading-400 font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="mt-100 text-200 leading-200 text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-200">{actions}</div> : null}
    </header>
  );
}

export function Eyebrow({ children, tick = false }: { children: ReactNode; tick?: boolean }) {
  return (
    <p className="font-numeric text-100 tracking-[0.14em] text-muted-foreground uppercase">
      {tick ? <span aria-hidden className="mr-200 inline-block h-[2px] w-300 rounded-full bg-signal align-middle" /> : null}
      {children}
    </p>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  as: Heading = 'h1',
}: {
  eyebrow?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  as?: 'h1' | 'h2';
}) {
  return (
    <div className="mb-600 flex flex-wrap items-end justify-between gap-400">
      <div className="min-w-0">
        {eyebrow ? <Eyebrow tick>{eyebrow}</Eyebrow> : null}
        <Heading
          className={cx(
            'mt-100 font-heading font-semibold tracking-tight',
            Heading === 'h1' ? 'text-hero-700 leading-hero-700' : 'text-600 leading-600'
          )}
        >
          {title}
        </Heading>
        {subtitle ? <p className="mt-200 max-w-3xl text-300 leading-300 text-muted-foreground">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-200">{actions}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-200 text-300 text-muted-foreground" role="status">
      <Loader2 className="icon-size-300 animate-spin" aria-hidden />
      {label ?? 'Loading…'}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-muted', className)} />;
}

export function LoadingBlock({ label, rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-300 p-500" aria-busy>
      <Spinner label={label} />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-200 px-500 py-800 text-center">
      <p className="font-heading text-400 font-semibold">{title}</p>
      {children ? <div className="max-w-xl text-300 leading-300 text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-200">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry, title = 'Something went wrong' }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-200 px-500 py-700 text-center">
      <XCircle className="icon-size-500 text-destructive" aria-hidden />
      <p className="font-heading text-400 font-semibold">{title}</p>
      <p className="max-w-xl text-300 leading-300 text-muted-foreground">{message}</p>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry} className="mt-200">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

const noticeIcon: Record<Tone, ReactNode> = {
  success: <CheckCircle2 className="icon-size-300 shrink-0" aria-hidden />,
  caution: <Info className="icon-size-300 shrink-0" aria-hidden />,
  warning: <AlertTriangle className="icon-size-300 shrink-0" aria-hidden />,
  danger: <XCircle className="icon-size-300 shrink-0" aria-hidden />,
  neutral: <Info className="icon-size-300 shrink-0" aria-hidden />,
  info: <Info className="icon-size-300 shrink-0" aria-hidden />,
};

export function Notice({ tone = 'info', title, children, className }: { tone?: Tone; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      className={cx('flex gap-300 rounded-md border px-400 py-300 text-300 leading-300', toneSoft[tone], className)}
    >
      {noticeIcon[tone]}
      <div className="min-w-0 space-y-100 text-foreground">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: T; label: string; badge?: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-100 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cx(
              '-mb-px inline-flex items-center gap-200 border-b-2 px-400 py-300 text-300 font-medium whitespace-nowrap transition-colors',
              active ? 'border-signal text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
            {tab.badge}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-300">
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-100 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'border-primary bg-primary' : 'border-input bg-muted'
        )}
      >
        <span
          aria-hidden
          className={cx(
            'inline-block h-3 w-3 rounded-full bg-card shadow transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
          )}
        />
      </button>
      <label htmlFor={id} className="min-w-0 cursor-pointer text-300 leading-300">
        <span className="font-medium">{label}</span>
        {description ? <span className="block text-200 leading-200 text-muted-foreground">{description}</span> : null}
      </label>
    </div>
  );
}

const control =
  'w-full rounded-md border border-input bg-card px-300 text-300 text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50';

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-100">
      <label htmlFor={htmlFor} className="block text-200 leading-200 font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="text-200 leading-200 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(control, 'h-9', props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(control, 'min-h-24 py-200 leading-300', props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(control, 'h-9 pr-200', props.className)} />;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** When false, Escape does not close the dialog (use it while an action is running). */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClose={() => {
        // Some browsers close the element on a second Escape even when the first was cancelled; bring it back.
        const el = ref.current;
        if (!dismissible && open && el && !el.open) {
          el.showModal();
          return;
        }
        onClose();
      }}
      aria-label={title}
      className={cx(
        'm-auto max-h-[88vh] w-[calc(100%-2rem)] rounded-xl border border-border bg-popover p-0 text-popover-foreground shadow-2xl backdrop:bg-foreground/40',
        wide ? 'max-w-4xl' : 'max-w-xl'
      )}
    >
      {open ? (
        <div className="flex max-h-[88vh] flex-col">
          <header className="border-b border-border px-500 py-400">
            <h2 className="font-heading text-500 leading-500 font-semibold">{title}</h2>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-500 py-400">{children}</div>
          {footer ? <footer className="flex flex-wrap justify-end gap-200 border-t border-border px-500 py-300">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export function Kpi({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className="rounded-lg border border-border bg-card px-400 py-300">
      <Eyebrow>{label}</Eyebrow>
      <p className={cx('mt-100 font-numeric text-hero-700 leading-hero-700 font-medium', tone === 'neutral' ? 'text-foreground' : undefined)}>{value}</p>
      {hint ? <p className="mt-100 text-200 leading-200 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('font-monospace text-200 leading-200 break-words', className)}>{children}</code>;
}
