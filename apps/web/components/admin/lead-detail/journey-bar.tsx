'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LIFECYCLE_CATEGORIES, type LifecycleCategory } from '@/lib/api-types';

/**
 * Sprint 1 (D6.3) — Captain Masr lifecycle Journey Bar.
 *
 * Four canonical steps:
 *   Fresh Lead → Signup → Active → DFT
 *
 * Visual contract:
 *   - The step matching `current` gets its lifecycle color (filled
 *     bg + colored ring + colored label).
 *   - Steps BEFORE the current step are rendered as "past" — soft
 *     filled with a check icon, indicating the lead has graduated
 *     through them.
 *   - Steps AFTER the current step are rendered as "future" —
 *     neutral outline.
 *   - Connector lines between steps are colored when the connector
 *     joins two "past or current" steps, neutral otherwise.
 *
 * Empty state:
 *   - When `current` is `null` (the lead's stage has no
 *     lifecycle_category set), every step renders as neutral and
 *     a one-line hint sits beneath the bar:
 *         "Pipeline stages aren't classified by journey step yet."
 *     Sprint 7's Pipeline Builder UI is where admins fix this.
 *
 * Permissions:
 *   - This component is read-only and renders whatever the caller
 *     already has authority to see. The Lead Detail page that
 *     hosts the bar already gates on `lead.read` via
 *     `findByIdInScopeOrThrow`, and `currentStageStatus` /
 *     `lifecycleCategory` are surfaced through `applyLeadFieldFilter`
 *     — D5 field-level access still wins.
 *   - RTL handled by the parent flex direction; we don't hard-code
 *     left-to-right anywhere.
 */

interface JourneyBarProps {
  current: LifecycleCategory | null;
  className?: string;
}

const STEP_ORDER: ReadonlyArray<LifecycleCategory> = LIFECYCLE_CATEGORIES;

interface StepStyles {
  /** Outer pill bg. */
  bg: string;
  /** Ring + dot + label text. */
  fg: string;
}

const STEP_STYLES: Record<LifecycleCategory, StepStyles> = {
  fresh_lead: {
    bg: 'bg-lifecycle-freshLeadBg',
    fg: 'text-lifecycle-freshLeadFg ring-lifecycle-freshLeadFg/40',
  },
  signup: {
    bg: 'bg-lifecycle-signupBg',
    fg: 'text-lifecycle-signupFg ring-lifecycle-signupFg/40',
  },
  active: {
    bg: 'bg-lifecycle-activeBg',
    fg: 'text-lifecycle-activeFg ring-lifecycle-activeFg/40',
  },
  dft: {
    bg: 'bg-lifecycle-dftBg',
    fg: 'text-lifecycle-dftFg ring-lifecycle-dftFg/40',
  },
};

type StepState = 'past' | 'current' | 'future' | 'inactive';

function resolveStepState(step: LifecycleCategory, current: LifecycleCategory | null): StepState {
  if (current === null) return 'inactive';
  const stepIndex = STEP_ORDER.indexOf(step);
  const currentIndex = STEP_ORDER.indexOf(current);
  if (stepIndex < currentIndex) return 'past';
  if (stepIndex === currentIndex) return 'current';
  return 'future';
}

export function JourneyBar({ current, className }: JourneyBarProps): JSX.Element {
  const t = useTranslations('admin.leads.detail.journey');

  return (
    <div className={cn('w-full', className)}>
      <ol
        // `role="list"` is implicit on <ol>; the aria-label gives
        // screen-reader users the bar's purpose without inventing a
        // header. Inline-grid keeps step widths equal across locales.
        aria-label={t('label')}
        className="grid grid-cols-[repeat(4,1fr)] items-center gap-0"
      >
        {STEP_ORDER.map((step, idx) => {
          const state = resolveStepState(step, current);
          const isLast = idx === STEP_ORDER.length - 1;
          const styles = STEP_STYLES[step];
          const isPast = state === 'past';
          const isCurrent = state === 'current';
          const isActiveOrPast = isPast || isCurrent;

          // Pill state classes.
          const pillBg =
            isActiveOrPast && current !== null
              ? styles.bg
              : 'bg-surface-card ring-1 ring-inset ring-surface-border';
          const pillFg =
            isActiveOrPast && current !== null ? styles.fg : 'text-ink-tertiary ring-0';

          return (
            <li
              key={step}
              aria-current={isCurrent ? 'step' : undefined}
              className="flex items-center gap-2"
            >
              {/* Step pill: dot + label */}
              <div
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset transition-colors',
                  pillBg,
                  pillFg,
                  isCurrent && 'shadow-sm',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
                    isPast
                      ? // Past: filled dot with check.
                        cn(styles.fg.replace('text-', 'bg-').split(' ')[0], 'text-white')
                      : isCurrent
                        ? // Current: filled dot, no check, ring matches fg.
                          cn(styles.fg.replace('text-', 'bg-').split(' ')[0])
                        : // Future / inactive: hollow dot.
                          'border border-current bg-transparent',
                  )}
                >
                  {isPast ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
                </span>
                <span className="truncate">{t(`steps.${step}`)}</span>
              </div>
              {/* Connector to the next step. Colored (2px) when this
                  step is "past-or-current" and a step exists ahead;
                  thin neutral (1px) otherwise. Inline style for the
                  colored case avoids a Tailwind safelist of 4
                  arbitrary-bg classes. */}
              {!isLast ? (
                <div
                  aria-hidden="true"
                  className={cn(
                    'flex-1',
                    current !== null && isActiveOrPast ? 'h-0.5' : 'h-px bg-surface-border',
                  )}
                  style={
                    current !== null && isActiveOrPast
                      ? { backgroundColor: connectorColorFor(step) }
                      : undefined
                  }
                />
              ) : null}
            </li>
          );
        })}
      </ol>
      {current === null ? (
        <p className="mt-2 text-xs text-ink-tertiary">{t('emptyState')}</p>
      ) : null}
    </div>
  );
}

/**
 * Connector color helper. Uses the foreground hex of the *starting*
 * step so the line visually flows from the colored pill into the
 * next. Hardcoded inline-style because tailwind safelist would
 * otherwise need to know all 4 bg classes at build time and
 * arbitrary-value bg-[#...] sidesteps that entirely.
 */
function connectorColorFor(step: LifecycleCategory): string {
  switch (step) {
    case 'fresh_lead':
      return '#3B82F6';
    case 'signup':
      return '#F59E0B';
    case 'active':
      return '#10B981';
    case 'dft':
      return '#8B5CF6';
  }
}
