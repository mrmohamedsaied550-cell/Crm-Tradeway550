import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: string;
  body?: string;
  /** Optional action button rendered below the body. */
  action?: React.ReactNode;
  /** Override the default icon. */
  icon?: React.ReactNode;
  className?: string;
}

/**
 * Shared empty / placeholder state for admin tables.
 * Used when a list returns zero rows after a successful fetch.
 */
export function EmptyState({ title, body, action, icon, className }: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface-card px-4 py-10 text-center',
        className,
      )}
      role="status"
    >
      <span className="text-ink-tertiary">
        {icon ?? <Inbox className="h-8 w-8" aria-hidden="true" />}
      </span>
      <p className="text-sm font-medium text-ink-primary">{title}</p>
      {body ? <p className="max-w-sm text-xs text-ink-secondary">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
