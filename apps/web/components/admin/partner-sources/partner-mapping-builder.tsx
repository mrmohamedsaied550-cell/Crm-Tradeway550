'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, partnerMappingsApi } from '@/lib/api';
import type {
  CreatePartnerMappingInput,
  PartnerMappingReadiness,
  PartnerMappingRow,
  PartnerTargetField,
  PartnerTransformKind,
} from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase D4 — D4.2: PartnerFieldMapping CRUD UI.
 *
 * Form-driven, NEVER raw JSON. One row per `(targetField,
 * sourceColumn)`. The component shows a phone-mapping-required
 * warning when readiness reports `phoneMapped = false` — the
 * warning is advisory; the backend doesn't block draft creation
 * (D4.3's sync engine will).
 *
 * Loads mappings + readiness in parallel on mount; refetches both
 * after every mutation so the warning recomputes.
 */
const TARGET_FIELDS: readonly PartnerTargetField[] = [
  'phone',
  'name',
  'partner_status',
  'partner_active_date',
  'partner_dft_date',
  'trip_count',
  'last_trip_at',
];

const TRANSFORM_KINDS: readonly PartnerTransformKind[] = [
  'passthrough',
  'parse_date',
  'to_e164',
  'lowercase',
];

export function PartnerMappingBuilder({
  partnerSourceId,
}: {
  partnerSourceId: string;
}): JSX.Element {
  const t = useTranslations('admin.partnerSources.mappings');
  const tCommon = useTranslations('admin.common');

  const canWrite = hasCapability('partner.source.write');

  const [rows, setRows] = useState<PartnerMappingRow[]>([]);
  const [readiness, setReadiness] = useState<PartnerMappingReadiness | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Local "new mapping" form
  const [draft, setDraft] = useState<CreatePartnerMappingInput>({
    sourceColumn: '',
    targetField: 'phone',
    transformKind: 'passthrough',
    isRequired: false,
    displayOrder: 0,
  });
  const [adding, setAdding] = useState<boolean>(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [list, ready] = await Promise.all([
        partnerMappingsApi.list(partnerSourceId),
        partnerMappingsApi.readiness(partnerSourceId),
      ]);
      setRows(list);
      setReadiness(ready);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [partnerSourceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onAdd(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!canWrite) return;
    setAdding(true);
    setDraftError(null);
    try {
      await partnerMappingsApi.create(partnerSourceId, {
        sourceColumn: draft.sourceColumn.trim(),
        targetField: draft.targetField,
        ...(draft.transformKind ? { transformKind: draft.transformKind } : {}),
        isRequired: draft.isRequired ?? false,
        displayOrder: draft.displayOrder ?? 0,
      });
      setDraft({
        sourceColumn: '',
        targetField: 'phone',
        transformKind: 'passthrough',
        isRequired: false,
        displayOrder: 0,
      });
      await reload();
    } catch (err) {
      setDraftError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function onRemove(mappingId: string): Promise<void> {
    if (!canWrite) return;
    setError(null);
    try {
      await partnerMappingsApi.remove(partnerSourceId, mappingId);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface p-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-base font-semibold text-ink-primary">{t('title')}</h3>
        <p className="text-sm text-ink-secondary">{t('subtitle')}</p>
      </header>

      {error ? <Notice tone="error">{error}</Notice> : null}

      {readiness && !readiness.phoneMapped ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('phoneRequiredWarning')}</span>
        </div>
      ) : null}

      {loading ? (
        <p className="text-sm text-ink-tertiary">{tCommon('loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-tertiary">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2"
            >
              <div className="flex flex-col leading-tight">
                <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-primary">
                  {t(`targetFields.${row.targetField}` as 'targetFields.phone')}
                  {row.isRequired ? <Badge tone="warning">{t('badges.required')}</Badge> : null}
                  {row.targetField === 'phone' ? (
                    <Badge tone="info">{t('badges.phone')}</Badge>
                  ) : null}
                </span>
                <span className="text-xs text-ink-tertiary">
                  {t('rowSummary', {
                    column: row.sourceColumn,
                    transform: t(
                      `transformKinds.${row.transformKind ?? 'passthrough'}` as 'transformKinds.passthrough',
                    ),
                  })}
                </span>
              </div>
              {canWrite ? (
                <Button variant="ghost" size="sm" onClick={() => void onRemove(row.id)}>
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {tCommon('delete')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <form
          onSubmit={onAdd}
          className="flex flex-col gap-3 rounded-md border border-surface-border bg-surface-card p-3"
        >
          <h4 className="text-sm font-semibold text-ink-primary">{t('addRow.title')}</h4>
          {draftError ? <Notice tone="error">{draftError}</Notice> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('addRow.targetField.label')} required>
              <Select
                value={draft.targetField}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, targetField: e.target.value as PartnerTargetField }))
                }
                required
              >
                {TARGET_FIELDS.map((tf) => (
                  <option key={tf} value={tf}>
                    {t(`targetFields.${tf}` as 'targetFields.phone')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label={t('addRow.sourceColumn.label')}
              hint={t('addRow.sourceColumn.helper')}
              required
            >
              <Input
                value={draft.sourceColumn}
                onChange={(e) => setDraft((d) => ({ ...d, sourceColumn: e.target.value }))}
                required
                maxLength={200}
              />
            </Field>
            <Field label={t('addRow.transformKind.label')} hint={t('addRow.transformKind.helper')}>
              <Select
                value={draft.transformKind ?? 'passthrough'}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    transformKind: e.target.value as PartnerTransformKind,
                  }))
                }
              >
                {TRANSFORM_KINDS.map((tk) => (
                  <option key={tk} value={tk}>
                    {t(`transformKinds.${tk}` as 'transformKinds.passthrough')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('addRow.displayOrder.label')}>
              <Input
                type="number"
                min={0}
                max={1000}
                value={draft.displayOrder ?? 0}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    displayOrder: Number.parseInt(e.target.value, 10) || 0,
                  }))
                }
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-primary">
            <input
              type="checkbox"
              checked={draft.isRequired ?? false}
              onChange={(e) => setDraft((d) => ({ ...d, isRequired: e.target.checked }))}
            />
            {t('addRow.isRequired.label')}
          </label>
          <div className="flex justify-end">
            <Button type="submit" size="sm" loading={adding}>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('addRow.cta')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
