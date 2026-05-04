'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, IdCard, Pencil, Phone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, contactsApi } from '@/lib/api';
import type { Contact, ConversationContactSummary } from '@/lib/api-types';

import { CaptainBadge, HasOpenLeadBadge } from './badges';

/**
 * D1.4 — Contact card.
 *
 * Renders the cleaned-identity projection of the WhatsApp contact:
 *   - displayName (or phone fallback)
 *   - phone (read-only, monospace)
 *   - language (read-only chip OR editable select)
 *   - first-seen / last-seen timestamps (read-only)
 *   - captain-active + has-open-lead flags
 *
 * Inline edit:
 *   - Visible only when the calling user has `whatsapp.contact.write`.
 *   - Edit form posts to PATCH /contacts/:id with displayName + language;
 *     the backend silently strips raw fields and audits the strip.
 *   - Cancel restores the previous values; failed save keeps the form
 *     open with a Notice — the operator can read the error and retry
 *     without retyping.
 *
 * NEVER renders rawProfile / originalPhone / originalDisplayName —
 * those reach the wire only on the super-admin raw endpoint, which
 * this UI never touches.
 */

const LANGUAGE_CHOICES: ReadonlyArray<{ code: string; labelKey: string }> = [
  { code: 'ar', labelKey: 'languages.ar' },
  { code: 'en', labelKey: 'languages.en' },
  { code: 'fr', labelKey: 'languages.fr' },
];

export function ContactCard({
  fallbackPhone,
  initialContact,
  contactId,
  canEdit,
}: {
  /** Phone shown when the cleaned displayName is empty. */
  fallbackPhone: string;
  /** Optional starting projection (from `conversation.contact`); avoids
   *  a flash-of-empty when the side panel mounts. */
  initialContact: ConversationContactSummary | Contact | null;
  /** Drives the lazy GET /contacts/:id call (firstSeenAt + lastSeenAt
   *  are not in the embedded summary). */
  contactId: string | null | undefined;
  /** True when the actor has `whatsapp.contact.write`. */
  canEdit: boolean;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.sidePanel.contact');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const [contact, setContact] = useState<Contact | null>(
    initialContact && 'firstSeenAt' in initialContact ? (initialContact as Contact) : null,
  );
  const [embedded, setEmbedded] = useState<ConversationContactSummary | null>(
    initialContact && !('firstSeenAt' in initialContact)
      ? (initialContact as ConversationContactSummary)
      : null,
  );
  const [editing, setEditing] = useState<boolean>(false);
  const [draftName, setDraftName] = useState<string>('');
  const [draftLanguage, setDraftLanguage] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Lazy fetch the full contact so the card can render firstSeenAt /
  // lastSeenAt — those aren't in the embedded summary. The fetch is
  // gated on contactId (no-op when there's no contact yet) and on
  // contact === null so we don't refetch when we already have the
  // safe projection.
  useEffect(() => {
    if (!contactId) {
      setContact(null);
      return;
    }
    if (contact?.id === contactId) return;
    let cancelled = false;
    contactsApi
      .get(contactId)
      .then((c) => {
        if (cancelled) return;
        setContact(c);
        setEmbedded(null);
      })
      .catch(() => {
        // 404 surfaces as a safe empty state — the embedded summary
        // is enough to render the cleaned identity.
      });
    return () => {
      cancelled = true;
    };
  }, [contact?.id, contactId]);

  function startEdit(): void {
    setDraftName(contact?.displayName ?? embedded?.displayName ?? '');
    setDraftLanguage(contact?.language ?? embedded?.language ?? '');
    setError(null);
    setEditing(true);
  }

  function cancelEdit(): void {
    setEditing(false);
    setError(null);
    setDraftName('');
    setDraftLanguage('');
  }

  async function save(): Promise<void> {
    if (!contactId) return;
    const trimmed = draftName.trim();
    if (!trimmed) {
      setError(t('nameRequired'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const updated = await contactsApi.update(contactId, {
        displayName: trimmed,
        language: draftLanguage.trim() || null,
      });
      setContact(updated);
      setEmbedded(null);
      setEditing(false);
      toast({ tone: 'success', title: t('saved') });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const displayName = contact?.displayName ?? embedded?.displayName ?? fallbackPhone;
  const language = contact?.language ?? embedded?.language ?? null;
  const isCaptain = contact?.isCaptain ?? embedded?.isCaptain ?? false;
  const hasOpenLead = contact?.hasOpenLead ?? embedded?.hasOpenLead ?? false;
  const firstSeenAt = contact?.firstSeenAt ?? null;
  const lastSeenAt = contact?.lastSeenAt ?? null;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-surface-border bg-surface-card p-3 shadow-sm">
      <header className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          <IdCard className="h-3.5 w-3.5" aria-hidden="true" />
          {t('title')}
        </h3>
        {canEdit && !editing ? (
          <button
            type="button"
            onClick={startEdit}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
            aria-label={t('editAria')}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{tCommon('edit')}</span>
          </button>
        ) : null}
        {editing ? (
          <button
            type="button"
            onClick={cancelEdit}
            disabled={submitting}
            className="inline-flex h-7 items-center justify-center rounded-md p-1 text-ink-secondary hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
            aria-label={tCommon('cancel')}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </header>

      {!editing ? (
        <>
          <p className="text-sm font-medium text-ink-primary">{displayName}</p>
          <p className="inline-flex items-center gap-1 font-mono text-xs text-ink-tertiary">
            <Phone className="h-3 w-3" aria-hidden="true" />
            {fallbackPhone}
          </p>
          {language ? (
            <p className="inline-flex items-center gap-1 text-xs text-ink-tertiary">
              <Globe className="h-3 w-3" aria-hidden="true" />
              {t('language', { language })}
            </p>
          ) : !canEdit ? (
            <p className="text-xs text-ink-tertiary">{t('languageMissing')}</p>
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            <CaptainBadge visible={isCaptain} />
            <HasOpenLeadBadge visible={hasOpenLead && !isCaptain} />
          </div>
          {firstSeenAt || lastSeenAt ? (
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-ink-tertiary">
              {firstSeenAt ? (
                <>
                  <dt className="font-medium">{t('firstSeen')}</dt>
                  <dd>{formatDate(firstSeenAt)}</dd>
                </>
              ) : null}
              {lastSeenAt ? (
                <>
                  <dt className="font-medium">{t('lastSeen')}</dt>
                  <dd>{formatDate(lastSeenAt)}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {!canEdit ? (
            <p className="mt-1 text-[11px] italic text-ink-tertiary">{t('readOnlyHint')}</p>
          ) : null}
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Field label={t('displayNameLabel')} required>
            <Input
              type="text"
              value={draftName}
              onChange={(e) => {
                setDraftName(e.target.value);
                if (error) setError(null);
              }}
              autoFocus
              maxLength={120}
            />
          </Field>
          <Field label={t('languageLabel')} hint={t('languageHint')}>
            <Select value={draftLanguage} onChange={(e) => setDraftLanguage(e.target.value)}>
              <option value="">{t('languageNone')}</option>
              {LANGUAGE_CHOICES.map((c) => (
                <option key={c.code} value={c.code}>
                  {t(c.labelKey as 'languages.ar')}
                </option>
              ))}
            </Select>
          </Field>
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={submitting}>
              {tCommon('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              loading={submitting}
              disabled={draftName.trim().length === 0}
            >
              {t('saveCta')}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    });
  } catch {
    return iso;
  }
}
