'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, ScrollText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/utils';
import { ApiError, auditApi, usersApi, type AuditRow } from '@/lib/api';
import type { AdminUser } from '@/lib/api-types';

/**
 * Phase D2 — D2.6 (extended in D3.7): filter chips for D2 + D3 + the
 * follow-up verbs. Selecting a chip narrows the local view to rows
 * whose `action` matches; the API itself still returns the full
 * stream — this is a client-side filter intentionally, so a TL can
 * flip between "everything in the last 200 events" and "just the
 * rotation verbs" without re-fetching.
 *
 * D3.7 added the rotation / review / SLA-review-pending verbs
 * (rotation, escalation policy, and lead-review queue) plus the
 * follow-up lifecycle verbs (`followup.create / .complete / .snooze
 * / .delete`). The actual followup audit names live in
 * `apps/api/src/follow-ups/follow-ups.service.ts`.
 */
const FILTER_AUDIT_ACTIONS = [
  // D2 — duplicates / reactivation / WhatsApp review
  'lead.duplicate_decision',
  'lead.reactivated',
  'tenant.duplicate_rules.update',
  'whatsapp.review.resolved',
  // D3 — rotation / SLA review / Lead Review Queue / escalation policy
  'lead.rotated',
  'lead.review.raised',
  'lead.review.resolved',
  'lead.sla.review_pending',
  'tenant.escalation_rules.update',
  // Follow-ups (housekeeping)
  'followup.create',
  'followup.complete',
  'followup.snooze',
  'followup.delete',
  // Phase D4 — partner data hub verbs (D4.3 sync / D4.4 verification
  // / D4.5 merge + evidence / D4.6 reconciliation review-opens).
  // The full list is intentionally surfaced together so an Ops
  // user can audit the whole partner-data trail in one chip pass.
  'partner.sync.completed',
  'partner.merge.applied',
  'partner.evidence.attached',
  'partner.verification.checked',
  'partner.reconciliation.review_opened',
] as const;
type FilterAuditAction = (typeof FILTER_AUDIT_ACTIONS)[number];

/**
 * /admin/audit (C40) — unified audit stream.
 *
 * Pulls /audit (audit_events + lead_activities, normalized + sorted
 * desc by timestamp). Each row shows action / actor / target / time
 * + a one-line metadata summary derived from the payload.
 */

function summarisePayload(payload: AuditRow['payload']): string {
  if (!payload || typeof payload !== 'object') return '';
  const entries = Object.entries(payload);
  if (entries.length === 0) return '';
  return entries
    .filter(([k]) => k !== 'event')
    .slice(0, 4)
    .map(([k, v]) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return `${k}: ${v.length > 60 ? `${v.slice(0, 60)}…` : v}`;
      if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${String(v)}`;
      return `${k}: …`;
    })
    .filter(Boolean)
    .join(' · ');
}

export default function AdminAuditPage(): JSX.Element {
  const t = useTranslations('admin.audit');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  // Phase D2 — D2.6 (extended in D3.7): chip-based filter for D2/D3
  // / follow-up audit verbs. `null` disables the filter; a chip code
  // shows only rows of that action.
  const [actionFilter, setActionFilter] = useState<FilterAuditAction | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, page] = await Promise.all([
        auditApi.list({ limit: 200 }),
        usersApi
          .list({ limit: 200 })
          .catch(() => ({ items: [] as AdminUser[], total: 0, limit: 200, offset: 0 })),
      ]);
      setRows(list);
      setUsers(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  // Apply the chip filter client-side. The API returns the unified
  // stream; this just narrows the rendered list.
  const visibleRows = useMemo(
    () => (actionFilter ? rows.filter((r) => r.action === actionFilter) : rows),
    [rows, actionFilter],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void reload()} loading={loading}>
            {tCommon('retry')}
          </Button>
        }
      />

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-2">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {/* Phase D2 — D2.6 (extended D3.7): chip filter for D2/D3 +
          follow-up audit verbs. The chip is a toggle; clicking the
          active one clears the filter. RTL-clean — `flex-wrap`
          rows + `gap-2` flow correctly mirrored. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-tertiary">{t('filterLabel')}</span>
        <button
          type="button"
          onClick={() => setActionFilter(null)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            actionFilter === null
              ? 'border-brand-600 bg-brand-50 text-brand-700'
              : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
          )}
        >
          {t('chips.all')}
        </button>
        {FILTER_AUDIT_ACTIONS.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => setActionFilter(actionFilter === code ? null : code)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              actionFilter === code
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
            )}
          >
            {t(`chips.${code}` as 'chips.lead.duplicate_decision')}
          </button>
        ))}
      </div>

      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-surface-border bg-surface-card p-8 text-sm text-ink-secondary">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {tCommon('loading')}
        </div>
      ) : visibleRows.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="h-7 w-7" aria-hidden="true" />}
          title={actionFilter ? t('emptyFilteredTitle') : t('emptyTitle')}
          body={actionFilter ? t('emptyFilteredBody') : t('emptyBody')}
        />
      ) : (
        <ul className="divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-card shadow-card">
          {visibleRows.map((r) => {
            const u = r.actorUserId ? userById.get(r.actorUserId) : null;
            const meta = summarisePayload(r.payload);
            return (
              <li key={`${r.source}-${r.id}`} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={r.source === 'audit_event' ? 'info' : 'neutral'}>{r.action}</Badge>
                    {r.entityType ? (
                      <span className="text-xs text-ink-tertiary">
                        {r.entityType}
                        {r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-xs text-ink-tertiary">
                    {new Date(r.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-ink-secondary">
                    {u ? `${u.name} (${u.email})` : t('actorSystem')}
                  </span>
                  {meta ? (
                    <span className="line-clamp-1 max-w-full text-xs text-ink-tertiary">
                      {meta}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
