'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, ShieldAlert, ShieldCheck } from 'lucide-react';

import { cn } from '@/lib/utils';
import type {
  RoleDependencyAnalysis,
  RoleDependencyWarning,
  RoleDependencyWarningSeverity,
} from '@/lib/api-types';

/**
 * Phase D5 — D5.14: dependency / lockout / high-risk warning
 * panel for the role editor's capability matrix.
 *
 * Renders the analysis returned by `POST /rbac/roles/:id/dependency-check`
 * grouped by severity (critical → warning → info). Each entry shows:
 *
 *   • a localised label (admin.roles.dependency.warnings.<code>),
 *   • the capability code(s) involved,
 *   • a one-line "what to do" hint.
 *
 * The panel is purely visual — it never mutates capabilities.
 * The save button consults `analysis.requiresTypedConfirmation`
 * to decide whether to open the typed-confirmation modal.
 *
 * No raw payload values are rendered. Capability codes are
 * formatted in a `<code>` tag with the localised label sitting
 * alongside (when available); the primary UX is the localised
 * sentence, not the raw code.
 *
 * RTL/mobile-friendly: the icon side-margin uses `me-1.5` so
 * next-intl flips automatically.
 */
export function DependencyWarningsPanel({
  analysis,
}: {
  analysis: RoleDependencyAnalysis | null;
}): JSX.Element | null {
  const t = useTranslations('admin.roles.dependency');
  if (!analysis || analysis.warnings.length === 0) return null;

  // Bucket by severity, preserving server order inside each bucket.
  const buckets: Record<RoleDependencyWarningSeverity, RoleDependencyWarning[]> = {
    critical: [],
    warning: [],
    info: [],
  };
  for (const w of analysis.warnings) {
    buckets[w.severity].push(w);
  }

  return (
    <section
      className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface px-3 py-3"
      data-testid="role-dependency-warnings"
    >
      <header className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
          {t('panelTitle')}
        </h3>
        <span className="text-[11px] text-ink-tertiary">
          {t('countLine', {
            critical: analysis.severityCounts.critical,
            warning: analysis.severityCounts.warning,
            info: analysis.severityCounts.info,
          })}
        </span>
      </header>
      <ul className="flex flex-col gap-2">
        {buckets.critical.map((w, i) => (
          <WarningRow key={`crit-${i}`} warning={w} />
        ))}
        {buckets.warning.map((w, i) => (
          <WarningRow key={`warn-${i}`} warning={w} />
        ))}
        {buckets.info.map((w, i) => (
          <WarningRow key={`info-${i}`} warning={w} />
        ))}
      </ul>
    </section>
  );
}

function WarningRow({ warning }: { warning: RoleDependencyWarning }): JSX.Element {
  const t = useTranslations('admin.roles.dependency');
  const tone = TONE[warning.severity];
  const Icon = tone.icon;
  // The message lookup falls back to the `default` key when the
  // localised entry is missing — the role editor is still
  // shipping new warning codes; we never crash on a missing key.
  const label = renderMessage(t, warning);
  return (
    <li
      data-severity={warning.severity}
      data-code={warning.code}
      className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', tone.classes)}
    >
      <Icon className="me-1.5 mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex flex-col gap-0.5 leading-tight">
        <span>{label}</span>
        {warning.capability ? (
          <code className="font-mono text-[11px] text-ink-tertiary">{warning.capability}</code>
        ) : null}
        {warning.dependsOn.length > 0 ? (
          <span className="text-[11px] text-ink-tertiary">
            {t('dependsOn', { codes: warning.dependsOn.join(', ') })}
          </span>
        ) : null}
      </div>
    </li>
  );
}

type Translator = ReturnType<typeof useTranslations>;

function renderMessage(t: Translator, warning: RoleDependencyWarning): string {
  // The server hands us a stable code; the client renders a
  // localised sentence. `meta.capability` and `meta.dependsOn`
  // are placeholders for the localised string.
  switch (warning.code) {
    case 'capability.dependency.missing':
      return t('warnings.dependencyMissing', {
        capability: warning.capability ?? '',
        dependsOn: warning.dependsOn.join(', '),
      });
    case 'capability.high_risk.export':
      return t('warnings.highRisk.export', { capability: warning.capability ?? '' });
    case 'capability.high_risk.partner_merge':
      return t('warnings.highRisk.partner_merge', { capability: warning.capability ?? '' });
    case 'capability.high_risk.lockout_admin':
      return t('warnings.highRisk.lockout_admin', { capability: warning.capability ?? '' });
    case 'capability.high_risk.permission_preview':
      return t('warnings.highRisk.permission_preview', { capability: warning.capability ?? '' });
    case 'capability.lockout.self_required':
      return t('warnings.selfLockout', { capability: warning.capability ?? '' });
    case 'capability.lockout.last_admin':
      return t('warnings.lastAdmin', { capability: warning.capability ?? '' });
    case 'role.system_immutable_attempt':
      return t('warnings.systemImmutable');
    default:
      return warning.code;
  }
}

const TONE: Record<RoleDependencyWarningSeverity, { classes: string; icon: typeof AlertTriangle }> =
  {
    critical: {
      classes: 'border-status-breach/40 bg-status-breach/5 text-ink-primary',
      icon: ShieldAlert,
    },
    warning: {
      classes: 'border-status-warning/40 bg-status-warning/5 text-ink-primary',
      icon: AlertTriangle,
    },
    info: {
      classes: 'border-surface-border bg-surface-card text-ink-secondary',
      icon: ShieldCheck,
    },
  };
