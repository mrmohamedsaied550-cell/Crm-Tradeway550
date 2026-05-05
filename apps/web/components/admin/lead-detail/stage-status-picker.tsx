'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ListChecks } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, leadsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { StageStatusesResponse } from '@/lib/api-types';

/**
 * Phase D3 — D3.3: stage-specific status picker.
 *
 * Renders near the top of the Lead Detail card stack so the agent
 * sees the current stage status before any other context, and can
 * pick / change it without scrolling.
 *
 * Visibility:
 *   - Hidden entirely if the user lacks `lead.stage.status.write`.
 *     Read-only viewers of the lead see the current-status badge
 *     elsewhere (the lead header — D3.7 polish); the picker is
 *     write-side.
 *   - When the stage has no `allowedStatuses` configured, the
 *     picker renders a subtle hint instead of a disabled dropdown
 *     so an admin who hasn't filled in the catalogue yet doesn't
 *     leak a useless control to agents.
 *
 * UX:
 *   - Current status is shown as a badge above the form. The form
 *     itself is always visible (so the agent can change the status,
 *     not just set it once).
 *   - Save button disabled until a status is picked AND it differs
 *     from the current one (so an accidental double-click doesn't
 *     spam an identical row into the timeline).
 *   - Notes are optional, max 1000 chars (server-enforced).
 *   - Locale-aware labels: `labelAr` is rendered in RTL contexts
 *     verbatim — the dropdown is locale-bound at render time.
 */
export function StageStatusPicker({
  leadId,
  /** Increment when a parent action mutates the lead (stage move,
   *  reactivation, …) so the picker re-fetches its catalogue + history. */
  refreshKey,
  /** Notify the parent that the lead detail data is stale. */
  onChanged,
}: {
  leadId: string;
  refreshKey?: string | number;
  onChanged?: () => void;
}): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.stageStatus');
  const tCommon = useTranslations('admin.common');
  const locale = useLocale();
  const { toast } = useToast();

  const canWrite = hasCapability('lead.stage.status.write');

  const [data, setData] = useState<StageStatusesResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await leadsApi.getStageStatuses(leadId);
      setData(result);
      // Reset form state on reload so a stage change doesn't carry
      // a stale draft over.
      setPicked('');
      setNotes('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  const allowedStatuses = useMemo(() => data?.allowedStatuses ?? [], [data]);
  const current = data?.currentStatus ?? null;

  const currentLabel = useMemo(() => {
    if (!current) return null;
    const entry = allowedStatuses.find((s) => s.code === current.status);
    if (!entry) return current.status;
    return locale === 'ar' ? entry.labelAr : entry.label;
  }, [current, allowedStatuses, locale]);

  if (!canWrite) return null;
  if (loading && !data) return null; // silent first-load skeleton — keeps the card rail clean

  const isUnchanged =
    picked === '' || (current?.status === picked && (notes ?? '') === (current?.notes ?? ''));
  const hasCatalogue = allowedStatuses.length > 0;

  async function onSave(): Promise<void> {
    if (!picked) return;
    setSubmitting(true);
    setError(null);
    try {
      await leadsApi.setStageStatus(leadId, {
        status: picked,
        ...(notes.trim().length > 0 && { notes: notes.trim() }),
      });
      toast({ tone: 'success', title: t('saved') });
      onChanged?.();
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'lead.stage.status.invalid') {
        setError(t('invalidStatus'));
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
        {currentLabel ? (
          <Badge tone="info">{currentLabel}</Badge>
        ) : (
          <span className="text-[11px] italic text-ink-tertiary">{t('none')}</span>
        )}
      </header>

      {data?.stage ? (
        <p className="text-[11px] text-ink-tertiary">{t('forStage', { stage: data.stage.name })}</p>
      ) : null}

      {!hasCatalogue ? (
        <Notice tone="info">{t('noCatalogue')}</Notice>
      ) : (
        <>
          <Field label={t('pickLabel')}>
            <Select
              value={picked}
              onChange={(e) => setPicked(e.target.value)}
              disabled={submitting}
            >
              <option value="">{tCommon('select')}</option>
              {allowedStatuses.map((s) => (
                <option key={s.code} value={s.code}>
                  {locale === 'ar' ? s.labelAr : s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('notesLabel')} hint={t('notesHint')}>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={1000}
              disabled={submitting}
            />
          </Field>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void onSave()}
            loading={submitting}
            disabled={isUnchanged || submitting}
          >
            {t('saveCta')}
          </Button>
        </>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
}
