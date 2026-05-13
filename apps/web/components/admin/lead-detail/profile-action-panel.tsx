'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { FieldGated } from '@/components/ui/field-gated';
import { ApiError, leadsApi } from '@/lib/api';
import type { Lead } from '@/lib/api-types';

/**
 * Sprint 2.D — Profile action panel.
 *
 * Editable contact fields (name / phone / email). Reuses the
 * existing `leadsApi.update(id, { name, phone, email })` PATCH
 * endpoint — D5 field-level access still wins because the server
 * silently no-ops writes the role lacks `lead.write` on, and the
 * UI wraps each input in `<FieldGated>` so denied roles see the
 * value read-only.
 *
 * Backend gap (per Sprint 2 spec): the schema does NOT yet model
 *   - Location (city / address / lat-lng)
 *   - Vehicle (plate / model / year / category)
 *   - Acquisition channel (separate from `attribution.source`)
 *   - Assignment editor (this panel surfaces an explicit
 *     placeholder rather than re-duplicating the existing
 *     Operations-tab assignment editor)
 *
 * These four blocks render as Notice placeholders so the agent
 * sees what's coming and the gap is documented in one place.
 * Sprint 2 explicitly accepts UI scaffolding for partial APIs.
 */

interface ProfileActionPanelProps {
  lead: Lead;
  onApplied: () => void;
  onClose: () => void;
}

export function ProfileActionPanel({
  lead,
  onApplied,
  onClose,
}: ProfileActionPanelProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.addAction.areas.profile');
  const tCommon = useTranslations('admin.common');

  const [name, setName] = useState<string>(lead.name);
  const [phone, setPhone] = useState<string>(lead.phone);
  const [email, setEmail] = useState<string>(lead.email ?? '');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const patch: { name?: string; phone?: string; email?: string | null } = {};
      if (name.trim() !== lead.name) patch.name = name.trim();
      if (phone.trim() !== lead.phone) patch.phone = phone.trim();
      const trimmedEmail = email.trim();
      const currentEmail = lead.email ?? '';
      if (trimmedEmail !== currentEmail) {
        patch.email = trimmedEmail.length > 0 ? trimmedEmail : null;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing changed — close cleanly.
        onClose();
        return;
      }
      await leadsApi.update(lead.id, patch);
      onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ───── Live contact fields ───── */}
      <Field label={t('nameLabel')}>
        <FieldGated resource="lead" field="name" mode="edit">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            disabled={submitting}
          />
        </FieldGated>
      </Field>
      <Field label={t('phoneLabel')}>
        <FieldGated resource="lead" field="phone" mode="edit">
          <Input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={32}
            placeholder="+201001234567"
            disabled={submitting}
          />
        </FieldGated>
      </Field>
      <Field label={t('emailLabel')}>
        <FieldGated resource="lead" field="email" mode="edit">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
            placeholder="optional@example.com"
            disabled={submitting}
            type="email"
          />
        </FieldGated>
      </Field>

      {/* ───── Backend-gap placeholders ─────
          These four sub-areas are part of the Sprint 2 spec but
          have no backend model yet. Surfacing them here so the
          agent reads "this is coming" rather than wondering where
          they are. Each block names the missing model + the
          sprint that owns the fix. */}
      <Notice tone="info">
        <p className="text-sm font-medium">{t('placeholders.heading')}</p>
        <ul className="mt-2 list-disc ps-4 text-xs text-ink-secondary">
          <li>{t('placeholders.location')}</li>
          <li>{t('placeholders.vehicle')}</li>
          <li>{t('placeholders.acquisition')}</li>
          <li>{t('placeholders.assignment')}</li>
        </ul>
      </Notice>

      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          {tCommon('cancel')}
        </Button>
        <Button onClick={() => void save()} loading={submitting}>
          {t('submit')}
        </Button>
      </div>
    </div>
  );
}
