'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ApiError, metaAdminApi } from '@/lib/api';
import type {
  MetaFieldMappingV2,
  MetaGraphFormQuestion,
  MetaMappingEntry,
  MetaMappingTarget,
} from '@/lib/api-types';

/**
 * Sprint M2 / Phase 3 — two-column field mapping editor used inside
 * `NewFacebookIntegrationModal` once a Form has been selected.
 *
 * Left column: the verbatim Meta question (label + key + type badge).
 * Right column: a dropdown of CRM-side targets (lead_field /
 * contact_field / ignore — custom_field is out of scope for the
 * Phase 3 admin UI and remains reachable only via the legacy JSON
 * editor).
 *
 * Emits the full V2 mapping back through `onMappingChange` so the
 * parent modal can submit it as part of the Save POST. Also surfaces
 * an `isValid` flag — true when at least one row maps to
 * `lead_field.name` AND one to `lead_field.phone`. The DTO enforces
 * the same rule server-side, but pre-validating in the UI saves a
 * round trip on the most common configuration mistake.
 */

export interface FieldMappingUIProps {
  connectionId: string;
  formId: string;
  onMappingChange: (mapping: MetaFieldMappingV2, isValid: boolean) => void;
}

type TargetKey = string; // serialised "kind:field" for select values

const TARGET_OPTIONS: ReadonlyArray<{ key: TargetKey; target: MetaMappingTarget }> = [
  { key: 'ignore', target: { kind: 'ignore' } },
  { key: 'lead_field:name', target: { kind: 'lead_field', field: 'name' } },
  { key: 'lead_field:phone', target: { kind: 'lead_field', field: 'phone' } },
  { key: 'lead_field:email', target: { kind: 'lead_field', field: 'email' } },
  { key: 'lead_field:source', target: { kind: 'lead_field', field: 'source' } },
  { key: 'lead_field:companyId', target: { kind: 'lead_field', field: 'companyId' } },
  { key: 'lead_field:countryId', target: { kind: 'lead_field', field: 'countryId' } },
  { key: 'contact_field:displayName', target: { kind: 'contact_field', field: 'displayName' } },
  { key: 'contact_field:language', target: { kind: 'contact_field', field: 'language' } },
];

function keyFor(target: MetaMappingTarget): TargetKey {
  if (target.kind === 'ignore') return 'ignore';
  if (target.kind === 'custom_field') return `custom_field:${target.customFieldId}`;
  return `${target.kind}:${target.field}`;
}

function targetFor(key: TargetKey): MetaMappingTarget {
  return (
    TARGET_OPTIONS.find((o) => o.key === key)?.target ?? ({ kind: 'ignore' } as MetaMappingTarget)
  );
}

/**
 * Best-effort default mapping based on Meta's question `type`. Saves
 * the operator the routine three clicks on every form (name → name,
 * phone → phone, email → email). Custom questions land on `ignore`
 * until the operator explicitly picks a destination.
 */
function suggestTarget(q: MetaGraphFormQuestion): MetaMappingTarget {
  switch (q.type.toUpperCase()) {
    case 'FULL_NAME':
    case 'FIRST_NAME':
    case 'LAST_NAME':
      return { kind: 'lead_field', field: 'name' };
    case 'PHONE':
    case 'PHONE_NUMBER':
      return { kind: 'lead_field', field: 'phone' };
    case 'EMAIL':
      return { kind: 'lead_field', field: 'email' };
    default:
      return { kind: 'ignore' };
  }
}

export function FieldMappingUI({
  connectionId,
  formId,
  onMappingChange,
}: FieldMappingUIProps): JSX.Element {
  const t = useTranslations('admin.metaIntegration.mapping');

  const [questions, setQuestions] = useState<MetaGraphFormQuestion[] | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<MetaMappingEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    metaAdminApi
      .getFormQuestions(connectionId, formId)
      .then((qs) => {
        if (cancelled) return;
        setQuestions(qs);
        setEntries(
          qs.map<MetaMappingEntry>((q) => ({
            metaKey: q.key,
            metaLabel: q.label,
            target: suggestTarget(q),
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
        setQuestions(null);
        setEntries([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, formId]);

  const isValid = useMemo(() => {
    const leadTargets = entries
      .filter((e) => e.target.kind === 'lead_field')
      .map((e) => (e.target as { kind: 'lead_field'; field: string }).field);
    return leadTargets.includes('name') && leadTargets.includes('phone');
  }, [entries]);

  // Propagate every state change upward so the parent can enable/disable
  // its Save button and capture the mapping at submit time. The mapping
  // is the source of truth; entries that resolve to `ignore` are still
  // included so re-opening the form preserves the operator's choice.
  useEffect(() => {
    onMappingChange({ version: 2, entries }, isValid);
  }, [entries, isValid, onMappingChange]);

  function updateEntry(index: number, key: TargetKey): void {
    setEntries((prev) => prev.map((e, i) => (i === index ? { ...e, target: targetFor(key) } : e)));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-surface-border bg-surface p-8 text-sm text-ink-tertiary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {t('loading')}
      </div>
    );
  }

  if (error) {
    return (
      <Notice tone="error">
        <span>{error}</span>
      </Notice>
    );
  }

  if (!questions || questions.length === 0) {
    return (
      <Notice tone="info">
        <span>{t('empty')}</span>
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <header className="grid grid-cols-12 gap-3 text-[11px] font-semibold uppercase tracking-wide text-ink-tertiary">
        <span className="col-span-6">{t('metaQuestion')}</span>
        <span className="col-span-6">{t('crmField')}</span>
      </header>
      <ul className="flex flex-col divide-y divide-surface-border rounded-lg border border-surface-border bg-surface-card">
        {questions.map((q, index) => {
          const entry = entries[index];
          const currentKey = entry ? keyFor(entry.target) : 'ignore';
          return (
            <li
              key={`${q.key}-${index}`}
              className="grid grid-cols-12 items-center gap-3 px-3 py-3"
            >
              <div className="col-span-6 flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-medium text-ink-primary" title={q.label}>
                  {q.label || q.key}
                </span>
                <span className="truncate font-mono text-[11px] text-ink-tertiary" title={q.key}>
                  {q.key}
                  {q.type ? ` · ${q.type.toLowerCase()}` : ''}
                </span>
              </div>
              <div className="col-span-6">
                <Select
                  value={currentKey}
                  onChange={(e) => updateEntry(index, e.target.value)}
                  aria-label={t('mapToLabel')}
                >
                  {TARGET_OPTIONS.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {t(`targets.${opt.key.replace(':', '_')}`)}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          );
        })}
      </ul>
      {!isValid ? (
        <p className="flex items-center gap-2 text-xs text-status-warning">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {t('requiredTargetsHint')}
        </p>
      ) : null}
    </div>
  );
}
