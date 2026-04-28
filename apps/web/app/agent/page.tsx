import { useTranslations } from 'next-intl';

/**
 * Agent Execution Mode placeholder.
 * Real surfaces (My Day, WhatsApp Inbox, Lead detail, Performance) land in
 * Phase 1.5 once auth + WhatsApp + presence are in place.
 */
export default function AgentPage() {
  const tAgent = useTranslations('agent');
  const tPlaceholder = useTranslations('agent.placeholder');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-primary">{tAgent('title')}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{tAgent('subtitle')}</p>
      </header>

      <section className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card">
        <h2 className="text-base font-semibold text-ink-primary">{tPlaceholder('heading')}</h2>
        <p className="mt-2 text-sm text-ink-secondary">{tPlaceholder('body')}</p>
      </section>
    </div>
  );
}
