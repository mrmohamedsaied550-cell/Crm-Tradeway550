import { useTranslations } from 'next-intl';

/**
 * Admin Insight Mode placeholder landing.
 * Real Companies / Countries / Teams / Users / Audit screens land in C12–C16.
 */
export default function AdminPage() {
  const tAdmin = useTranslations('admin');
  const tPlaceholder = useTranslations('admin.placeholder');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-primary">{tAdmin('title')}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{tAdmin('subtitle')}</p>
      </header>

      <section className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card">
        <h2 className="text-base font-semibold text-ink-primary">{tPlaceholder('heading')}</h2>
        <p className="mt-2 text-sm text-ink-secondary">{tPlaceholder('body')}</p>

        <ul className="mt-5 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatusChip kind="healthy" label="healthy" />
          <StatusChip kind="warning" label="warning" />
          <StatusChip kind="breach" label="breach" />
          <StatusChip kind="inactive" label="inactive" />
          <StatusChip kind="info" label="info" />
        </ul>
      </section>
    </div>
  );
}

type StatusKind = 'healthy' | 'warning' | 'breach' | 'inactive' | 'info';

function StatusChip({ kind, label }: { kind: StatusKind; label: string }) {
  const styles: Record<StatusKind, string> = {
    healthy: 'bg-status-healthy/10 text-status-healthy ring-status-healthy/30',
    warning: 'bg-status-warning/10 text-status-warning ring-status-warning/30',
    breach: 'bg-status-breach/10  text-status-breach  ring-status-breach/30',
    inactive: 'bg-status-inactive/10 text-status-inactive ring-status-inactive/30',
    info: 'bg-status-info/10    text-status-info    ring-status-info/30',
  };

  return (
    <li
      className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-xs font-medium uppercase tracking-wide ring-1 ${styles[kind]}`}
    >
      {label}
    </li>
  );
}
