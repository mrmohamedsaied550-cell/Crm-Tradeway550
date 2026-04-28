import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

type Tone = 'success' | 'error' | 'info';

const TONES: Record<Tone, { wrap: string; icon: typeof Info }> = {
  success: {
    wrap: 'border-status-healthy/30 bg-status-healthy/10 text-status-healthy',
    icon: CheckCircle2,
  },
  error: {
    wrap: 'border-status-breach/30 bg-status-breach/10 text-status-breach',
    icon: AlertCircle,
  },
  info: {
    wrap: 'border-status-info/30 bg-status-info/10 text-status-info',
    icon: Info,
  },
};

export interface NoticeProps {
  tone: Tone;
  children: React.ReactNode;
  className?: string;
}

/** Inline notification used at the top of admin pages — no portal, no auto-dismiss. */
export function Notice({ tone, children, className }: NoticeProps): JSX.Element {
  const { wrap, icon: Icon } = TONES[tone];
  return (
    <div
      className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', wrap, className)}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1">{children}</div>
    </div>
  );
}
