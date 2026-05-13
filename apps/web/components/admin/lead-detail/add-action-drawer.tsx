'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ArrowLeft,
  FileText,
  type LucideIcon,
  Network,
  Route,
  StickyNote,
  User,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { ApiError, leadsApi } from '@/lib/api';
import type { Lead } from '@/lib/api-types';
import { LifecycleActionPanel } from './lifecycle-action-panel';
import { ProfileActionPanel } from './profile-action-panel';
import { DocumentsActionPanel } from './documents-action-panel';
import { PartnerDataActionPanel } from './partner-data-action-panel';

/**
 * Sprint 2.B — Smart Add Action drawer.
 *
 * Single entry point for all in-page lead updates. Replaces the
 * "one giant form" anti-pattern with a router screen that asks
 * "What do you want to update?" then drops the agent into a
 * focused, scope-locked panel.
 *
 * Areas (per Sprint 2 spec):
 *   1. Lifecycle / Stage & Status   — Sprint 2.C wires this fully
 *   2. Profile Info                  — Sprint 2.D
 *   3. Documents                     — Sprint 2.E (UI scaffold +
 *                                       backend gap notice)
 *   4. Partner Data                  — Sprint 2.F (UI scaffold +
 *                                       backend gap notice)
 *   5. Note Only                     — Sprint 2.G (live, wired
 *                                       through `leadsApi.addActivity`)
 *
 * Why a router screen instead of inline tabs in the drawer:
 *   - Each area has different fields, different validation, and
 *     different smart-rule reactivity (especially Lifecycle).
 *     Forcing them all into one wide form makes every action feel
 *     overloaded and slow.
 *   - The router pattern matches the agreed UX: agent picks an
 *     intent, panel focuses on that intent only.
 *
 * Permissions:
 *   - The drawer trusts the parent page's `lead.read` gate to
 *     have already passed (the drawer never opens unless the page
 *     is rendered).
 *   - Each panel's write paths self-gate (e.g. Lifecycle reads
 *     `lead.stage.status.write` via the existing
 *     StageStatusPicker; Profile reads field-level access via
 *     FieldGated; Note Only requires `lead.activity.write` —
 *     enforced server-side by leadsApi.addActivity).
 *
 * Sprint 2.B ships:
 *   - The router screen (5 area buttons)
 *   - The Note Only panel (live wiring through addActivity)
 *   - Placeholder panels for the other 4 areas that name the
 *     responsible Sprint and the backend gap if any.
 *
 * Sprint 2.C / .D / .E / .F replace each placeholder one at a time.
 */

export type AddActionArea = 'lifecycle' | 'profile' | 'documents' | 'partnerData' | 'note';

interface AddActionDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Required: the lead the action targets. Renders nothing when null. */
  lead: Lead | null;
  /** Caller-side callback after a successful write — usually `reload()`. */
  onApplied: () => void;
}

interface AreaDescriptor {
  id: AddActionArea;
  icon: LucideIcon;
  /** Translation key suffix under `admin.leads.detail.addAction.areas`. */
  titleKey: string;
  descriptionKey: string;
}

const AREAS: ReadonlyArray<AreaDescriptor> = [
  {
    id: 'lifecycle',
    icon: Route,
    titleKey: 'lifecycle.title',
    descriptionKey: 'lifecycle.description',
  },
  { id: 'profile', icon: User, titleKey: 'profile.title', descriptionKey: 'profile.description' },
  {
    id: 'documents',
    icon: FileText,
    titleKey: 'documents.title',
    descriptionKey: 'documents.description',
  },
  {
    id: 'partnerData',
    icon: Network,
    titleKey: 'partnerData.title',
    descriptionKey: 'partnerData.description',
  },
  { id: 'note', icon: StickyNote, titleKey: 'note.title', descriptionKey: 'note.description' },
];

export function AddActionDrawer({
  open,
  onClose,
  lead,
  onApplied,
}: AddActionDrawerProps): JSX.Element | null {
  const t = useTranslations('admin.leads.detail.addAction');
  const tCommon = useTranslations('admin.common');

  const [area, setArea] = useState<AddActionArea | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─────── Note Only state (Sprint 2.G) ───────
  const [noteBody, setNoteBody] = useState<string>('');
  const [noteSubmitting, setNoteSubmitting] = useState<boolean>(false);

  function close(): void {
    if (noteSubmitting) return;
    setArea(null);
    setNoteBody('');
    setError(null);
    onClose();
  }

  function goBack(): void {
    if (noteSubmitting) return;
    setArea(null);
    setError(null);
  }

  async function submitNote(): Promise<void> {
    if (!lead) return;
    const body = noteBody.trim();
    if (body.length === 0) return;
    setNoteSubmitting(true);
    setError(null);
    try {
      await leadsApi.addActivity(lead.id, { type: 'note', body });
      setNoteBody('');
      onApplied();
      close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setNoteSubmitting(false);
    }
  }

  if (!open || !lead) return null;

  const title = area === null ? t('routerTitle') : t(`areas.${area}.title`);

  return (
    <Modal open={open} title={title} onClose={close} width="lg">
      {area === null ? (
        // ─────── Router screen: 5 area cards ───────
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink-secondary">{t('routerPrompt')}</p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {AREAS.map((a) => {
              const Icon = a.icon;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => setArea(a.id)}
                    className="flex w-full items-start gap-3 rounded-lg border border-surface-border bg-surface-card p-3 text-start transition-colors hover:border-brand-400 hover:bg-brand-50"
                  >
                    <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-700">
                      <Icon className="h-4 w-4" aria-hidden={true} />
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-ink-primary">
                        {t(`areas.${a.titleKey}`)}
                      </span>
                      <span className="text-xs text-ink-secondary">
                        {t(`areas.${a.descriptionKey}`)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        // ─────── Area-specific panel ───────
        <div className="flex flex-col gap-4">
          {/* Back to router */}
          <button
            type="button"
            onClick={goBack}
            disabled={noteSubmitting}
            className="inline-flex items-center gap-1 self-start text-xs font-medium text-ink-secondary hover:text-ink-primary disabled:opacity-60"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden={true} />
            {t('backToRouter')}
          </button>

          {error ? <Notice tone="error">{error}</Notice> : null}

          {area === 'lifecycle' ? (
            // ─────── Sprint 2.C — Lifecycle action panel (LIVE) ───────
            <LifecycleActionPanel lead={lead} onApplied={onApplied} onClose={close} />
          ) : area === 'profile' ? (
            // ─────── Sprint 2.D — Profile action panel (LIVE) ───────
            // Editable name / phone / email via leadsApi.update +
            // FieldGated; backend gaps (location / vehicle /
            // acquisition / assignment) are surfaced as a
            // Notice block inside the panel.
            <ProfileActionPanel lead={lead} onApplied={onApplied} onClose={close} />
          ) : area === 'documents' ? (
            // ─────── Sprint 2.E — Documents panel (SCAFFOLD) ───────
            // 5 status states displayed read-only; backend gap is
            // explicit (no LeadDocument model yet).
            <DocumentsActionPanel lead={lead} onClose={close} />
          ) : area === 'partnerData' ? (
            // ─────── Sprint 2.F — Partner Data panel (SCAFFOLD) ───────
            // Reuses the D4.4 PartnerDataCard read-only projection;
            // backend gap (write paths apply/link/review) is
            // explicit.
            <PartnerDataActionPanel lead={lead} onClose={close} />
          ) : area === 'note' ? (
            // ─────── Sprint 2.G — Note Only panel (LIVE) ───────
            // Re-uses the same `leadsApi.addActivity` endpoint that
            // powers the inline composer; capability gate
            // (`lead.activity.write`) is server-enforced. The
            // composer in the Overview tab still works — this
            // drawer is just the drawer-driven path.
            <div className="flex flex-col gap-3">
              <p className="text-sm text-ink-secondary">{t('areas.note.helper')}</p>
              <Field label={t('areas.note.fieldLabel')}>
                <Textarea
                  value={noteBody}
                  onChange={(e) => setNoteBody(e.target.value)}
                  rows={6}
                  maxLength={4000}
                  placeholder={t('areas.note.placeholder')}
                />
              </Field>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-tertiary">{noteBody.length}/4000</span>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={close} disabled={noteSubmitting}>
                    {tCommon('cancel')}
                  </Button>
                  <Button
                    onClick={() => void submitNote()}
                    disabled={noteBody.trim().length === 0}
                    loading={noteSubmitting}
                  >
                    {t('areas.note.submit')}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            // ─────── Placeholder panels for the other 4 areas ───────
            // Sprint 2.C wires `lifecycle`, 2.D wires `profile`,
            // 2.E wires `documents`, 2.F wires `partnerData`.
            // Until then each placeholder shows what Sprint will
            // bring it online and (for Documents) the backend gap.
            <Notice tone="info">
              <p className="text-sm">{t(`areas.${area}.pendingTitle`)}</p>
              <p className="mt-1 text-xs text-ink-secondary">
                {t(`areas.${area}.pendingDescription`)}
              </p>
            </Notice>
          )}
        </div>
      )}
    </Modal>
  );
}
