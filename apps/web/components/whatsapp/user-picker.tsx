'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Search, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { ApiError, usersApi } from '@/lib/api';
import type { AdminUser } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * D1.3 — searchable user picker used by Reassign / Handover modals.
 *
 * Calls GET /users?q=… with a 200 ms debounce. The backend already
 * scope-filters the list (RLS + the admin module's same-tenant
 * policy), so the picker only ever shows users the actor can target.
 *
 * Selecting a user surfaces a compact chip with a clear button so
 * the operator can swap the choice without re-opening the
 * dropdown.
 */
export function UserPicker({
  value,
  onChange,
  excludeUserId,
  autoFocus,
  ariaLabel,
}: {
  value: AdminUser | null;
  onChange: (user: AdminUser | null) => void;
  /** Hide this user from the result list (typically the current owner). */
  excludeUserId?: string | null;
  autoFocus?: boolean;
  ariaLabel?: string;
}): JSX.Element {
  const t = useTranslations('admin.whatsapp.assign');
  const [query, setQuery] = useState<string>('');
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AdminUser[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Debounced search. The backend caps `q` at the same shape as other
  // admin lookups; we hit it with min-1 chars so an empty query
  // returns a recent slice rather than every active user.
  useEffect(() => {
    if (!open) return undefined;
    const handle = setTimeout(() => {
      setLoading(true);
      setError(null);
      usersApi
        .list({ q: query.trim() || undefined, status: 'active', limit: 25 })
        .then((page) => {
          setResults(excludeUserId ? page.items.filter((u) => u.id !== excludeUserId) : page.items);
        })
        .catch((err) => {
          setError(err instanceof ApiError ? err.message : String(err));
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [excludeUserId, open, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e: MouseEvent): void {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const visibleResults = useMemo(() => results.slice(0, 25), [results]);

  if (value) {
    return (
      <div
        className="flex items-center justify-between gap-2 rounded-md border border-surface-border bg-surface-card px-3 py-2 text-sm"
        aria-label={ariaLabel}
      >
        <div className="min-w-0">
          <p className="truncate font-medium text-ink-primary">{value.name}</p>
          <p className="truncate text-xs text-ink-tertiary">{value.email}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setQuery('');
            setOpen(true);
          }}
          className="rounded-md p-1 text-ink-secondary hover:bg-brand-50 hover:text-brand-700"
          aria-label={t('clearSelection')}
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          className="pointer-events-none absolute start-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-tertiary"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={t('searchPlaceholder')}
          className="ps-8"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-label={ariaLabel ?? t('searchPlaceholder')}
        />
      </div>
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-surface-border bg-surface-card shadow-card"
        >
          {loading ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-ink-tertiary">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              {t('searching')}
            </p>
          ) : error ? (
            <p className="px-3 py-2 text-xs text-status-breach">{error}</p>
          ) : visibleResults.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-tertiary">{t('noUsersFound')}</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {visibleResults.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected="false"
                    onClick={() => {
                      onChange(u);
                      setOpen(false);
                      setQuery('');
                    }}
                    className={cn(
                      'flex w-full flex-col items-start px-3 py-2 text-start',
                      'hover:bg-brand-50 focus-visible:bg-brand-50 focus-visible:outline-none',
                    )}
                  >
                    <span className="text-sm font-medium text-ink-primary">{u.name}</span>
                    <span className="text-xs text-ink-tertiary">{u.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
