'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRight, Check, Clock, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError, transitionRequestsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { LeadTransitionRequestRow } from '@/lib/api-types';

/**
 * Sprint 3 (D7.1) — Pending Approval card.
 *
 * Renders on Lead Detail (Stage Context area). Lists the lead's
 * transition-request history with the active pending row (if any)
 * highlighted at the top, plus rejected rows beneath so the
 * agent sees the "Returned to me" history without leaving the
 * page.
 *
 * Approve / Reject CTAs are gated by `lead.transition.approve` —
 * users without it see the pending row read-only. Rejected rows
 * are read-only for everyone.
 *
 * Reject opens an inline Modal that captures the REQUIRED
 * rejection reason + an optional corrective-action title. On
 * confirm, the API creates a corrective LeadFollowUp owned by
 * the requester so the original owner has a concrete next
 * action — the lead does NOT move.
 */
interface PendingTransitionRequestCardProps {
  leadId: string;
  /** Bumped by the parent after any save so the card refetches. */
  refreshKey?: string | number;
  /** Caller-side callback after a successful approve / reject. */
  onChanged: () => void;
}

export function PendingTransitionRequestCard({
  leadId,
  refreshKey,
  onChanged,
}: PendingTransitionRequestCardProps): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.pendingTransition');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();

  const [rows, setRows] = useState<readonly LeadTransitionRequestRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Reject modal state
  const [rejectTarget, setRejectTarget] = useState<LeadTransitionRequestRow | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');
  const [rejectActionTitle, setRejectActionTitle] = useState<string>('');

  const canDecide = hasCapability('lead.transition.approve');

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await transitionRequestsApi.list(leadId);
      setRows(result);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // ─────── Approve ───────
  async function approve(row: LeadTransitionRequestRow): Promise<void> {
    setActionPending(row.id);
    setActionError(null);
    try {
      await transitionRequestsApi.approve(row.id);
      onChanged();
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  // ─────── Reject ───────
  function openReject(row: LeadTransitionRequestRow): void {
    setRejectTarget(row);
    setRejectReason('');
    setRejectActionTitle('');
    setActionError(null);
  }

  async function confirmReject(): Promise<void> {
    if (!rejectTarget) return;
    if (rejectReason.trim().length === 0) return;
    setActionPending(rejectTarget.id);
    setActionError(null);
    try {
      await transitionRequestsApi.reject(rejectTarget.id, {
        reason: rejectReason.trim(),
        ...(rejectActionTitle.trim().length > 0
          ? { correctiveActionTitle: rejectActionTitle.trim() }
          : {}),
      });
      setRejectTarget(null);
      onChanged();
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  }

  // ─────── Render ───────
  // Filter: show pending (always) + rejected within last 14 days
  // so the "Returned to me" surface is visible until the corrective
  // action is dealt with.
  const visibleRows = rows.filter((r) => {
    if (r.state === 'pending') return true;
    if (r.state === 'rejected') {
      const decided = r.decidedAt ? new Date(r.decidedAt).getTime() : 0;
      return Date.now() - decided < 14 * 24 * 60 * 60 * 1000;
    }
    return false;
  });

  if (loading) return null;
  if (loadError) {
    return <Notice tone="error">{loadError}</Notice>;
  }
  if (visibleRows.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-4 shadow-card"
      aria-labelledby="pending-transition-heading"
    >
      <header className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-status-warning" aria-hidden="true" />
        <h3
          id="pending-transition-heading"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('heading')}
        </h3>
      </header>

      {actionError ? (
        <div className="mb-3">
          <Notice tone="error">{actionError}</Notice>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {visibleRows.map((row) => {
          const isPending = row.state === 'pending';
          const isRejected = row.state === 'rejected';
          const stateTone = isPending
            ? 'text-status-warning bg-status-warning/15'
            : 'text-status-breach bg-status-breach/15';
          return (
            <li
              key={row.id}
              className="rounded-md border border-surface-border bg-surface-card p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${stateTone}`}
                >
                  {isPending ? (
                    <Clock className="h-3 w-3" aria-hidden="true" />
                  ) : (
                    <X className="h-3 w-3" aria-hidden="true" />
                  )}
                  {t(`state.${row.state}`)}
                </span>
                <span className="text-sm font-medium text-ink-primary">{row.fromStage.name}</span>
                <ArrowRight className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
                <span className="text-sm font-medium text-ink-primary">{row.toStage.name}</span>
                {row.requestedStatusCode ? (
                  <span className="text-xs text-ink-secondary">· {row.requestedStatusCode}</span>
                ) : null}
              </div>

              <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-ink-secondary sm:grid-cols-2">
                <div>
                  <dt className="inline font-semibold text-ink-tertiary">{t('requestedBy')}: </dt>
                  <dd className="inline">{row.requestedBy.name}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink-tertiary">{t('submitted')}: </dt>
                  <dd className="inline">
                    {new Date(row.createdAt).toLocaleString(locale === 'ar' ? 'ar' : 'en')}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-semibold text-ink-tertiary">{t('approver')}: </dt>
                  <dd className="inline">
                    {t(`approverKind.${approverKindLabelKey(row.approverKind)}`, {
                      role: row.approverRoleCode ?? '',
                    })}
                  </dd>
                </div>
                {row.handoffRule ? (
                  <div>
                    <dt className="inline font-semibold text-ink-tertiary">{t('handoff')}: </dt>
                    <dd className="inline">{t(`handoffRule.${row.handoffRule}`)}</dd>
                  </div>
                ) : null}
                {row.notes ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-semibold text-ink-tertiary">{t('notes')}: </dt>
                    <dd className="inline">{row.notes}</dd>
                  </div>
                ) : null}
                {isRejected && row.decisionReason ? (
                  <div className="sm:col-span-2">
                    <dt className="inline font-semibold text-status-breach">
                      {t('rejectionReason')}:{' '}
                    </dt>
                    <dd className="inline text-ink-primary">{row.decisionReason}</dd>
                  </div>
                ) : null}
                {isRejected && row.decidedBy ? (
                  <div>
                    <dt className="inline font-semibold text-ink-tertiary">{t('rejectedBy')}: </dt>
                    <dd className="inline">{row.decidedBy.name}</dd>
                  </div>
                ) : null}
              </dl>

              {isPending ? (
                <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                  {canDecide ? (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openReject(row)}
                        disabled={actionPending !== null}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('reject')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void approve(row)}
                        loading={actionPending === row.id}
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('approve')}
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs italic text-ink-tertiary">{t('readOnlyHint')}</span>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* ─── Reject modal ─── */}
      <Modal
        open={rejectTarget !== null}
        title={t('rejectModal.title')}
        onClose={() => setRejectTarget(null)}
        width="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setRejectTarget(null)}
              disabled={actionPending !== null}
            >
              {tCommon('cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmReject()}
              disabled={rejectReason.trim().length === 0}
              loading={actionPending !== null}
            >
              {t('rejectModal.confirm')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-secondary">{t('rejectModal.helper')}</p>
          <Field label={t('rejectModal.reasonLabel')}>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={t('rejectModal.reasonPlaceholder')}
            />
          </Field>
          <Field label={t('rejectModal.correctiveActionLabel')}>
            <Input
              value={rejectActionTitle}
              onChange={(e) => setRejectActionTitle(e.target.value)}
              maxLength={160}
              placeholder={t('rejectModal.correctiveActionPlaceholder')}
            />
          </Field>
          <p className="text-xs text-ink-tertiary">{t('rejectModal.correctiveActionHint')}</p>
        </div>
      </Modal>
    </section>
  );
}

/** Maps the persisted approverKind into a translation key suffix. */
function approverKindLabelKey(kind: string): string {
  if (kind.startsWith('role:')) return 'role';
  return kind;
}
