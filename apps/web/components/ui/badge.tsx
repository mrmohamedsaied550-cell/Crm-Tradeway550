import { cn } from '@/lib/utils';

type Tone = 'healthy' | 'warning' | 'breach' | 'inactive' | 'info' | 'neutral';

const TONES: Record<Tone, string> = {
  healthy: 'bg-status-healthy/10 text-status-healthy ring-status-healthy/30',
  warning: 'bg-status-warning/10 text-status-warning ring-status-warning/30',
  breach: 'bg-status-breach/10 text-status-breach ring-status-breach/30',
  inactive: 'bg-status-inactive/10 text-status-inactive ring-status-inactive/30',
  info: 'bg-status-info/10 text-status-info ring-status-info/30',
  neutral: 'bg-surface text-ink-secondary ring-surface-border',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
