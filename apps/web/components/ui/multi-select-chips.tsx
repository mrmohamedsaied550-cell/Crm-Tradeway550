'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Phase C — C9: searchable multi-select with chip-style selection.
 *
 * Designed for the user-scope-assignment dialog. The list of options
 * is small (companies / countries inside one tenant — typically tens,
 * never thousands), so the implementation is intentionally simple:
 * a static option list, a substring filter, click-to-toggle, chips
 * for the current selection.
 *
 * Behaviour:
 *   • Click the input row to open the popover, click outside to close.
 *   • Type to filter (case-insensitive substring on `label`).
 *   • Click an option to toggle; selected options show a check mark.
 *   • Selected items render as chips above the input; click the X to
 *     remove. Backspace inside an empty search input also removes
 *     the last selected chip — common pattern from native chip UIs.
 *   • Disabled mode hides the popover trigger and renders chips as
 *     plain text.
 */

export interface MultiSelectOption {
  value: string;
  label: string;
  /** Optional secondary text shown under the label inside the popover. */
  secondary?: string;
}

interface Props {
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Optional id used to wire `aria-labelledby`. */
  id?: string;
}

export function MultiSelectChips({
  options,
  value,
  onChange,
  placeholder,
  emptyText,
  disabled,
  id,
}: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (!containerRef.current) return;
      if (e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const valueSet = useMemo(() => new Set(value), [value]);
  const optionByValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.secondary?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  function toggle(val: string): void {
    if (disabled) return;
    if (valueSet.has(val)) {
      onChange(value.filter((v) => v !== val));
    } else {
      onChange([...value, val]);
    }
  }

  function removeChip(val: string): void {
    if (disabled) return;
    onChange(value.filter((v) => v !== val));
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (e.key === 'Backspace' && query === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative" id={id}>
      <div
        className={cn(
          'flex min-h-[2.25rem] w-full flex-wrap items-center gap-1 rounded-md border border-surface-border bg-surface-card px-2 py-1 text-sm',
          'focus-within:ring-2 focus-within:ring-brand-600 focus-within:ring-offset-1',
          disabled && 'cursor-not-allowed opacity-60',
        )}
        onClick={() => {
          if (disabled) return;
          setOpen(true);
          inputRef.current?.focus();
        }}
      >
        {value.map((val) => {
          const opt = optionByValue.get(val);
          const label = opt?.label ?? val;
          return (
            <span
              key={val}
              className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
            >
              {label}
              {!disabled ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeChip(val);
                  }}
                  className="rounded-sm text-brand-700 hover:bg-brand-100"
                  aria-label={`Remove ${label}`}
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              ) : null}
            </span>
          );
        })}
        {!disabled ? (
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setOpen(true)}
            placeholder={value.length === 0 ? placeholder : ''}
            className="min-w-[4rem] flex-1 border-0 bg-transparent px-1 py-0.5 text-sm text-ink-primary placeholder:text-ink-tertiary focus:outline-none"
          />
        ) : null}
      </div>

      {open && !disabled ? (
        <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-surface-border bg-surface-card shadow-lg">
          {filtered.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-ink-tertiary">
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              {emptyText ?? 'No matches'}
            </div>
          ) : (
            <ul className="py-1">
              {filtered.map((o) => {
                const selected = valueSet.has(o.value);
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      onClick={() => toggle(o.value)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-start text-sm hover:bg-brand-50',
                        selected && 'bg-brand-50/50',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          selected
                            ? 'border-brand-600 bg-brand-600 text-white'
                            : 'border-surface-border',
                        )}
                        aria-hidden="true"
                      >
                        {selected ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="flex flex-col leading-tight">
                        <span className="text-ink-primary">{o.label}</span>
                        {o.secondary ? (
                          <span className="text-[11px] text-ink-tertiary">{o.secondary}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
