'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChevronRight, ListChecks } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, leadsApi } from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import type { StageStatusesResponse } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * Phase D3 — D3.3: stage-specific status picker.
 * Redesigned to match the mockup: gradient card with Stage → Status
 * display and clickable status chips.
 */
export function StageStatusPicker({
  leadId,
  refreshKey,
  onChanged,
}: {
  leadId: string;
  refreshKey?: string | number;
  onChanged?: () => void;
}): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.stageStatus');
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
  if (loading && !data) return null;

  const hasCatalogue = allowedStatuses.length > 0;
  const isUnchanged =
    picked === '' || (current?.status === picked && (notes ?? '') === (current?.notes ?? ''));

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
    <section className="rounded-xl border border-blue-200 bg-gradient-to-r from-blue-50 to-indigo-50 p-4 shadow-sm">
      {/* Header: Stage → Status */}
      <header className="flex items-center justify-between gap-2 mb-3">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500">
          <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
      </header>

      {/* Stage → Status display */}
      <div className="flex items-center gap-3 mb-3">
        {data?.stage ? (
          <>
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Stage:</span>
              <span className="text-sm font-bold text-blue-700 bg-blue-100 px-3 py-1 rounded-lg">
                {data.stage.name}
              </span>
            </div>
            <ChevronRight className="h-4 w-4 text-gray-300" aria-hidden="true" />
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Status:</span>
              {currentLabel ? (
                <span className="text-sm font-bold text-indigo-700 bg-indigo-100 px-3 py-1 rounded-lg">
                  {currentLabel}
                </span>
              ) : (
                <span className="text-sm italic text-gray-400">{t('none')}</span>
              )}
            </div>
          </>
        ) : null}
      </div>

      {!hasCatalogue ? (
        <Notice tone="info">{t('noCatalogue')}</Notice>
      ) : (
        <>
          {/* Status chips — clickable pills */}
          <div className="flex items-center gap-1.5 flex-wrap mb-3">
            <span className="text-[10px] text-gray-400 uppercase tracking-wider mr-1">
              Available:
            </span>
            {allowedStatuses.map((s) => {
              const label = locale === 'ar' ? s.labelAr : s.label;
              const isActive = current?.status === s.code;
              const isPicked = picked === s.code;
              return (
                <button
                  key={s.code}
                  type="button"
                  onClick={() => setPicked(s.code)}
                  disabled={submitting}
                  className={cn(
                    'text-[11px] px-2.5 py-1 rounded-full border transition-all',
                    isActive && !isPicked
                      ? 'bg-blue-600 text-white border-blue-600 font-semibold'
                      : isPicked
                        ? 'bg-indigo-600 text-white border-indigo-600 font-semibold ring-2 ring-indigo-300'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:bg-blue-50',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Notes field — only show when a status is picked */}
          {picked ? (
            <div className="flex flex-col gap-2">
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
            </div>
          ) : null}
        </>
      )}

      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
}
