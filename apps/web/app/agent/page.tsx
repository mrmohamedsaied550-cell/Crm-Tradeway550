import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ClipboardList, MessagesSquare, ArrowUpRight } from 'lucide-react';

/**
 * Agent landing page (C31).
 *
 * Two cards into the active surfaces: My Leads and WhatsApp Inbox.
 */
export default function AgentPage() {
  const tAgent = useTranslations('agent');
  const tWorkspace = useTranslations('agent.workspace');
  const tInbox = useTranslations('agent.inbox');

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-primary">{tAgent('title')}</h1>
        <p className="mt-1 text-sm text-ink-secondary">{tAgent('subtitle')}</p>
      </header>

      <ul className="grid gap-4 sm:grid-cols-2">
        <li>
          <Link
            href="/agent/workspace"
            className="group flex h-full flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card transition-colors hover:border-brand-200 hover:bg-brand-50"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-600/10 text-brand-700">
                <ClipboardList className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-ink-primary">{tWorkspace('title')}</span>
            </div>
            <p className="text-xs text-ink-secondary">{tWorkspace('subtitle')}</p>
            <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 group-hover:text-brand-800">
              {tWorkspace('open')}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        </li>
        <li>
          <Link
            href="/agent/inbox"
            className="group flex h-full flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-5 shadow-card transition-colors hover:border-brand-200 hover:bg-brand-50"
          >
            <div className="flex items-center gap-2">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-600/10 text-brand-700">
                <MessagesSquare className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="text-sm font-semibold text-ink-primary">{tInbox('title')}</span>
            </div>
            <p className="text-xs text-ink-secondary">{tInbox('subtitle')}</p>
            <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 group-hover:text-brand-800">
              {tInbox('open')}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
          </Link>
        </li>
      </ul>
    </div>
  );
}
