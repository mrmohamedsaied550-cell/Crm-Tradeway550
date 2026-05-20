'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LIFECYCLE_CATEGORIES, type LifecycleCategory } from '@/lib/api-types';

/**
 * Sprint 1 (D6.3) — Captain Masr lifecycle Journey Bar.
 * Redesigned to match the mockup: larger boxes with checkmarks,
 * colored borders, and "Day X" indicator on current step.
 */

interface JourneyBarProps {
  current: LifecycleCategory | null;
  className?: string;
}

const STEP_ORDER: ReadonlyArray<LifecycleCategory> = LIFECYCLE_CATEGORIES;

interface StepColor {
  completed: string;
  current: string;
  future: string;
  connector: string;
}

const STEP_COLORS: Record<LifecycleCategory, StepColor> = {
  fresh_lead: {
    completed: 'bg-green-100 border-green-300 text-green-700',
    current: 'bg-blue-50 border-blue-500 text-blue-700 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]',
    future: 'bg-gray-50 border-gray-200 text-gray-400',
    connector: 'bg-green-300',
  },
  signup: {
    completed: 'bg-green-100 border-green-300 text-green-700',
    current: 'bg-amber-50 border-amber-500 text-amber-700 shadow-[0_0_0_3px_rgba(245,158,11,0.15)]',
    future: 'bg-gray-50 border-gray-200 text-gray-400',
    connector: 'bg-green-300',
  },
  active: {
    completed: 'bg-green-100 border-green-300 text-green-700',
    current: 'bg-emerald-50 border-emerald-500 text-emerald-700 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]',
    future: 'bg-gray-50 border-gray-200 text-gray-400',
    connector: 'bg-green-300',
  },
  dft: {
    completed: 'bg-green-100 border-green-300 text-green-700',
    current: 'bg-purple-50 border-purple-500 text-purple-700 shadow-[0_0_0_3px_rgba(139,92,246,0.15)]',
    future: 'bg-gray-50 border-gray-200 text-gray-400',
    connector: 'bg-green-300',
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
        aria-label={t('label')}
        className="flex items-center gap-1"
      >
        {STEP_ORDER.map((step, idx) => {
          const state = resolveStepState(step, current);
          const isLast = idx === STEP_ORDER.length - 1;
          const colors = STEP_COLORS[step];
          const isPast = state === 'past';
          const isCurrent = state === 'current';

          const boxClass = isPast
            ? colors.completed
            : isCurrent
              ? colors.current
              : colors.future;

          return (
            <li key={step} className="flex items-center" aria-current={isCurrent ? 'step' : undefined}>
              <div
                className={cn(
                  'relative border-2 rounded-md px-3 py-1.5 text-xs font-medium transition-all',
                  boxClass,
                )}
              >
                {/* Checkmark badge for completed steps */}
                {isPast && (
                  <span className="absolute -top-1.5 -right-1.5 bg-green-500 text-white rounded-full w-4 h-4 flex items-center justify-center">
                    <Check className="h-2.5 w-2.5" aria-hidden="true" />
                  </span>
                )}
                <span className="truncate">{t(`steps.${step}`)}</span>
                {/* Day indicator on current step */}
                {isCurrent && (
                  <span className="block text-[10px] opacity-70 mt-0.5">●</span>
                )}
              </div>
              {/* Connector line */}
              {!isLast && (
                <div
                  aria-hidden="true"
                  className={cn(
                    'w-4 h-0.5 mx-0.5',
                    isPast || (isCurrent && idx < STEP_ORDER.length - 1)
                      ? colors.connector
                      : 'bg-gray-200',
                  )}
                />
              )}
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
