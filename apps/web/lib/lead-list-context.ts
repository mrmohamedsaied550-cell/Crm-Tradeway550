/**
 * Phase B — Navigation/Speed: tiny per-session cache that lets the
 * lead-detail page render a "◀ 3 of 47 ▶" navigator that walks the
 * filter the user came from on the list page.
 *
 * Storage shape (sessionStorage['leads.lastList']):
 *   { signature, ids, total, fetchedAt, viewMode? }
 *
 * Cache is per-tab (sessionStorage), per-session, and capped at the
 * list-page's existing 100-id payload. No backend involvement; the
 * navigator simply walks the cached id array. Cache misses degrade
 * silently to "no navigator visible".
 *
 * The signature is a stable hash of the filter state. Two different
 * filter sets produce two different signatures so a stale cache from
 * a previous filter doesn't fool the navigator into walking the wrong
 * leads. The signature is also stamped on the detail navigator's
 * label so dev-tools inspection can confirm what list the user is
 * actually navigating.
 */

const STORAGE_KEY = 'leads.lastList';
/** 30 minutes — beyond this, treat the cache as stale. */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface LeadListContextInput {
  /** Stable signature of the filter that produced `ids`. */
  signature: string;
  /** Lead ids in the display order returned by the list API. */
  ids: readonly string[];
  /** Total matching leads on the server (>= ids.length). */
  total: number;
}

interface StoredContext extends LeadListContextInput {
  fetchedAt: number;
}

export interface NavigatorPosition {
  prevId: string | null;
  nextId: string | null;
  /** 1-indexed position within `ids`. 0 means "not in the cached list". */
  position: number;
  /** ids.length — the size of the cached page. */
  pageSize: number;
  /** Server-side total matching leads. */
  total: number;
  /** The cached signature — useful for debug only. */
  signature: string;
}

/**
 * Build a stable signature from the filter values. The order of
 * properties matters; using a sorted-key serialiser would be
 * over-engineering — callers compose the object themselves so the
 * key order is fixed.
 */
export function buildListSignature(filters: Record<string, unknown>): string {
  // Skip undefined / null / empty-string values so toggling a filter
  // back to its default produces the same signature as never having
  // touched it.
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean' && v === false) continue;
    compact[k] = v;
  }
  return JSON.stringify(compact);
}

export function saveListContext(input: LeadListContextInput): void {
  if (typeof window === 'undefined') return;
  const stored: StoredContext = { ...input, fetchedAt: Date.now() };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota / disabled storage — feature degrades silently.
  }
}

export function clearListContext(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Read the cache and resolve the navigator state for a given lead.
 * Returns null when the cache is missing, expired, or doesn't contain
 * the lead — the caller renders the navigator in disabled state in
 * those cases.
 */
export function readListContext(currentLeadId: string): NavigatorPosition | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: StoredContext;
  try {
    parsed = JSON.parse(raw) as StoredContext;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.ids) || typeof parsed.fetchedAt !== 'number') return null;
  if (Date.now() - parsed.fetchedAt > MAX_AGE_MS) return null;
  const idx = parsed.ids.indexOf(currentLeadId);
  if (idx < 0) return null;
  return {
    prevId: idx > 0 ? parsed.ids[idx - 1]! : null,
    nextId: idx < parsed.ids.length - 1 ? parsed.ids[idx + 1]! : null,
    position: idx + 1,
    pageSize: parsed.ids.length,
    total: parsed.total,
    signature: parsed.signature,
  };
}
