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
import {
  AUDIT_ACTION_GROUP_CODES,
  governanceActionLabel,
  isGovernanceAction,
  summariseAuditPayload,
  type AuditActionGroupCode,
} from '@/lib/audit-governance';
import type { AdminUser } from '@/lib/api-types';

/**
 * Phase D5 — D5.11: chip-based filter that calls the new
 * `?actionPrefix=<group>` server filter for governance verbs.
 *
 * Two filter modes coexist on the page:
 *
 *   • Action-verb chips (D2 / D3 / partner — pre-D5.11) filter
 *     CLIENT-SIDE on the cached `rows` list. Each chip narrows to
 *     a specific verb.
 *
 *   • Governance group chips (D5.11) call the BACKEND with
 *     `actionPrefix=<allow-listed code>`. Selecting one re-fetches
 *     a server-filtered slice (rbac.*, tenant.export.*, etc.). The
 *     two modes are mutually exclusive: choosing a group chip
 *     clears the verb chip and vice versa, and "All" clears both.
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
  // Phase D4 — partner data hub verbs
  'partner.sync.completed',
  'partner.merge.applied',
  'partner.evidence.attached',
  'partner.verification.checked',
  'partner.reconciliation.review_opened',
] as const;
type FilterAuditAction = (typeof FILTER_AUDIT_ACTIONS)[number];

export default function AdminAuditPage(): JSX.Element {
  const t = useTranslations('admin.audit');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<AuditRow[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<FilterAuditAction | null>(null);
  // Phase D5 — D5.11: allow-listed group code currently filtering
  // the server-side feed. `null` disables the group filter.
  const [groupFilter, setGroupFilter] = useState<AuditActionGroupCode | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, page] = await Promise.all([
        auditApi.list({
          limit: 200,
          ...(groupFilter && { actionPrefix: groupFilter }),
        }),
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
  }, [groupFilter]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

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

      {/* Phase D5 — D5.11: governance group chips (server filter) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-tertiary">{t('groupFilterLabel')}</span>
        <ChipButton
          active={groupFilter === null}
          onClick={() => {
            setGroupFilter(null);
            setActionFilter(null);
          }}
          label={t('chips.all')}
        />
        {AUDIT_ACTION_GROUP_CODES.map((code) => (
          <ChipButton
            key={code}
            active={groupFilter === code}
            onClick={() => {
              setGroupFilter(groupFilter === code ? null : code);
              setActionFilter(null);
            }}
            label={t(`groups.${code}` as 'groups.rbac')}
          />
        ))}
      </div>

      {/* Pre-D5.11 verb chips (client filter) */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-tertiary">{t('filterLabel')}</span>
        <ChipButton
          active={actionFilter === null}
          onClick={() => setActionFilter(null)}
          label={t('chips.all')}
        />
        {FILTER_AUDIT_ACTIONS.map((code) => (
          <ChipButton
            key={code}
            active={actionFilter === code}
            onClick={() => setActionFilter(actionFilter === code ? null : code)}
            label={t(`chips.${code}` as 'chips.lead.duplicate_decision')}
          />
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
          title={actionFilter || groupFilter ? t('emptyFilteredTitle') : t('emptyTitle')}
          body={actionFilter || groupFilter ? t('emptyFilteredBody') : t('emptyBody')}
        />
      ) : (
        <ul className="divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-card shadow-card">
          {visibleRows.map((r) => {
            const u = r.actorUserId ? userById.get(r.actorUserId) : null;
            const isGov = isGovernanceAction(r.action);
            const meta = isGov
              ? summariseAuditPayload(r.action, r.payload)
              : legacySummariseAuditPayload(r.payload);
            return (
              <li key={`${r.source}-${r.id}`} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {/* D5.11: governance verbs render the human-readable
                        label alongside the raw action code so an
                        admin scanning the strip sees "Tenant backup
                        export completed" instead of just
                        `tenant.export.completed`. */}
                    <Badge
                      tone={isGov ? 'warning' : r.source === 'audit_event' ? 'info' : 'neutral'}
                    >
                      {isGov ? governanceActionLabel(t, r.action) : r.action}
                    </Badge>
                    {isGov ? (
                      <code className="font-mono text-[11px] text-ink-tertiary">{r.action}</code>
                    ) : null}
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

function ChipButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-brand-600 bg-brand-50 text-brand-700'
          : 'border-surface-border bg-surface-card text-ink-secondary hover:bg-surface',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Pre-D5.11 generic key-value summariser. Kept for non-governance
 * verbs. Governance verbs go through `summariseAuditPayload` from
 * `lib/audit-governance.ts` for safer, structured copy.
 */
function legacySummariseAuditPayload(payload: AuditRow['payload']): string {
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
