'use client';

import { type KeyboardEvent, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Sprint 2.A — Smart Tabs primitive.
 *
 * Horizontal tab bar with an underline accent on the active tab.
 * Headless: callers manage the `value` and `onChange` themselves so
 * deep-link state (URL query param), persistence (localStorage),
 * or simple useState all live at the parent.
 *
 * Visual contract (matches the approved enterprise CRM direction):
 *   - Inactive tab: muted ink, transparent underline, hover hint.
 *   - Active tab: ink-primary text, brand-500 underline, semibold.
 *   - Disabled tab: tertiary ink, no-op click, no hover.
 *   - Optional inline count badge (e.g. "12") right-aligned within
 *     the tab — kept neutral so the bar doesn't pull focus.
 *
 * Accessibility:
 *   - `role="tablist"` + `aria-orientation` on the bar.
 *   - Each `<button>` carries `role="tab"`, `aria-selected`,
 *     `tabIndex={isActive ? 0 : -1}` per WAI-ARIA tabs pattern.
 *   - Arrow Left / Right move focus + activation between tabs
 *     (wraps around).
 *   - Home / End jump to first / last.
 *   - The matching <TabPanel> wires `role="tabpanel"` +
 *     `aria-labelledby` automatically.
 *
 * RTL: the underline + arrow-key wiring use logical directions —
 *   ArrowLeft in RTL still feels "previous", browsers handle the
 *   axis flip on the focus ring naturally.
 */

export interface TabDescriptor<T extends string = string> {
  id: T;
  label: string;
  /** Optional inline counter badge (e.g. unresolved review count). */
  count?: number;
  /** Disables the tab; it stays visible but unclickable. */
  disabled?: boolean;
}

interface TabsProps<T extends string = string> {
  /** Logical id of the active tab. Controlled. */
  value: T;
  /** Caller decides what to do — usually set local state. */
  onChange: (id: T) => void;
  /** Ordered list of tab descriptors. */
  tabs: ReadonlyArray<TabDescriptor<T>>;
  /** Hint for screen readers describing what the tablist controls. */
  ariaLabel?: string;
  className?: string;
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
  ariaLabel,
  className,
}: TabsProps<T>): JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = useCallback((target: T) => {
    const node = listRef.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${target}"]`);
    node?.focus();
  }, []);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const enabled = tabs.filter((t) => !t.disabled);
      if (enabled.length === 0) return;
      const currentIdx = enabled.findIndex((t) => t.id === value);
      if (currentIdx === -1) return;
      const move = (delta: number) => {
        const next = enabled[(currentIdx + delta + enabled.length) % enabled.length]!;
        onChange(next.id);
        focusTab(next.id);
      };
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowLeft':
          e.preventDefault();
          move(e.key === 'ArrowRight' ? 1 : -1);
          break;
        case 'Home':
          e.preventDefault();
          onChange(enabled[0]!.id);
          focusTab(enabled[0]!.id);
          break;
        case 'End':
          e.preventDefault();
          onChange(enabled[enabled.length - 1]!.id);
          focusTab(enabled[enabled.length - 1]!.id);
          break;
        default:
          break;
      }
    },
    [tabs, value, onChange, focusTab],
  );

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn(
        // Slim divider line under the row of tabs.
        'flex items-end gap-1 overflow-x-auto border-b border-surface-border',
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === value;
        const isDisabled = Boolean(tab.disabled);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            id={`tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={isActive ? 0 : -1}
            disabled={isDisabled}
            onClick={() => {
              if (!isDisabled) onChange(tab.id);
            }}
            className={cn(
              'group relative flex items-center gap-2 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
              // Bottom underline accent — uses a -1px negative margin so it
              // sits on top of the tablist's bottom border for the active
              // tab.
              '-mb-px border-b-2',
              isActive
                ? 'border-brand-500 font-semibold text-ink-primary'
                : isDisabled
                  ? 'cursor-not-allowed border-transparent text-ink-tertiary'
                  : 'border-transparent text-ink-secondary hover:text-ink-primary',
            )}
          >
            <span>{tab.label}</span>
            {typeof tab.count === 'number' && tab.count > 0 ? (
              <span
                className={cn(
                  'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
                  isActive ? 'bg-brand-50 text-brand-700' : 'bg-surface-border text-ink-secondary',
                )}
              >
                {tab.count > 99 ? '99+' : tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Panel wrapper. Use one per tab; show/hide via `active`. The
 * `aria-labelledby` ties the panel to its tab button so screen
 * readers announce both when focus enters the panel.
 *
 * Renders nothing (returns `null`) when inactive so React doesn't
 * keep the subtree mounted — this matters for tabs that fetch
 * their own data on mount.
 */
export function TabPanel({
  id,
  active,
  children,
  className,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
  className?: string;
}): JSX.Element | null {
  if (!active) return null;
  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      className={cn('focus:outline-none', className)}
      tabIndex={0}
    >
      {children}
    </div>
  );
}
