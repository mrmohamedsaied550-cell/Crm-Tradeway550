'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { DependencyWarningsPanel } from './dependency-warnings-panel';
import type { RoleDependencyAnalysis } from '@/lib/api-types';

/**
 * Phase D5 — D5.14: typed-confirmation modal for critical role
 * changes.
 *
 * Opens when a save attempt receives the
 * `role.dependency.confirmation_required` 400 response from the
 * API (or when the client wants to gate a save preemptively
 * before sending it). The operator must echo
 * `analysis.typedConfirmationPhrase` verbatim — a checkbox or
 * "yes/no" prompt is intentionally not enough for these
 * changes (per D5.14 spec).
 *
 * The modal renders the full analysis at the top so the
 * operator sees exactly which changes triggered the
 * requirement; below it sits the input + a primary action that
 * stays disabled until the input matches the phrase.
 *
 * Accessibility:
 *   • The input carries an aria-label matching the title.
 *   • The disabled state is announced via `aria-disabled` so
 *     screen readers don't treat it as a missing element.
 *   • Pressing Escape closes the modal (handled by the
 *     underlying `<Modal>`).
 */
export function TypedConfirmationModal({
  open,
  analysis,
  loading,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  analysis: RoleDependencyAnalysis | null;
  loading: boolean;
  onCancel: () => void;
  /** Called with the phrase the operator typed. Parent passes it through to the API. */
  onConfirm: (phrase: string) => void;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.dependency');
  const [phrase, setPhrase] = useState<string>('');

  if (!open || !analysis) return null;

  const required = analysis.typedConfirmationPhrase;
  const matches = phrase === required;

  return (
    <Modal
      open={open}
      title={t('confirmModal.title')}
      onClose={onCancel}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={loading}>
            {t('confirmModal.cancel')}
          </Button>
          <Button
            variant="danger"
            onClick={() => onConfirm(phrase)}
            loading={loading}
            disabled={!matches || loading}
            aria-disabled={!matches || loading}
            data-testid="role-typed-confirmation-confirm"
          >
            {t('confirmModal.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Notice tone="error">
          <span>{t('confirmModal.intro')}</span>
        </Notice>

        <DependencyWarningsPanel analysis={analysis} />

        <Field
          label={t('confirmModal.fieldLabel', { phrase: required })}
          hint={t('confirmModal.fieldHint')}
        >
          <Input
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            data-testid="role-typed-confirmation-input"
          />
        </Field>
      </div>
    </Modal>
  );
}
