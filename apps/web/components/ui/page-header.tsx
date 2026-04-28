import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-3', className)}>
      <div>
        <h1 className="text-xl font-semibold text-ink-primary">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-ink-secondary">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
