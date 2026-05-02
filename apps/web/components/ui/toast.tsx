'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircle2, X, AlertCircle, AlertTriangle, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * P3-06 — global toaster.
 *
 * Replaces the page-local `setNotice` flows (which require their own
 * Notice render slot, never auto-dismiss, and pile up at the top of
 * the page). The provider exposes `useToast()`; `<ToastViewport />`
 * renders the actual stack and is mounted once in the root layout.
 *
 * Behaviour:
 *   - up to 4 toasts are visible at once; older ones evict on overflow
 *     so a runaway loop can't fill the screen,
 *   - default 5 s auto-dismiss; pass `duration: 0` to keep until
 *     manually dismissed,
 *   - hovering a toast pauses its timer (keeps the user from missing
 *     a message they were reading when the cursor moved over it),
 *   - manually dismissable via the close button + keyboard escape.
 *
 * RTL: positioned at `bottom-4 end-4` so the stack lives in the
 * trailing corner of either ltr or rtl layouts.
 */

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastInput {
  tone?: ToastTone;
  /** One-line title shown in bold. */
  title: string;
  /** Optional second line — explains the title. */
  body?: string;
  /** Auto-dismiss after this many ms. 0 = sticky. Default 5000. */
  duration?: number;
}

interface ActiveToast extends Required<Pick<ToastInput, 'title' | 'tone'>> {
  id: string;
  body?: string;
  duration: number;
}

const MAX_VISIBLE = 4;

const ToastCtx = createContext<{
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
} | null>(null);

let toastCounter = 0;
function nextId(): string {
  toastCounter += 1;
  return `t${Date.now().toString(36)}-${toastCounter.toString(36)}`;
}

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ActiveToast[]>([]);

  const dismiss = useCallback((id: string): void => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput): void => {
    const next: ActiveToast = {
      id: nextId(),
      tone: input.tone ?? 'info',
      title: input.title,
      ...(input.body !== undefined && { body: input.body }),
      duration: input.duration ?? 5000,
    };
    setToasts((prev) => {
      // Evict the oldest when we'd overflow MAX_VISIBLE.
      const trimmed = prev.length >= MAX_VISIBLE ? prev.slice(1) : prev;
      return [...trimmed, next];
    });
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </ToastCtx.Provider>
  );
}

export function useToast(): {
  toast: (input: ToastInput) => void;
  dismiss: (id: string) => void;
} {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Safe no-op so a stray useToast() call (e.g. during SSR before the
    // provider mounts) doesn't blow up; visible toasts still require
    // the provider to be wired in the root layout.
    return { toast: () => {}, dismiss: () => {} };
  }
  return ctx;
}

interface ViewportProps {
  toasts: ActiveToast[];
  dismiss: (id: string) => void;
}

function ToastViewport({ toasts, dismiss }: ViewportProps): JSX.Element | null {
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-4 end-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

interface ItemProps {
  toast: ActiveToast;
  onDismiss: () => void;
}

const TONE_STYLES: Record<ToastTone, { wrap: string; icon: typeof Info }> = {
  success: {
    wrap: 'border-status-healthy/30 bg-status-healthy/10 text-status-healthy',
    icon: CheckCircle2,
  },
  error: {
    wrap: 'border-status-breach/30 bg-status-breach/10 text-status-breach',
    icon: AlertCircle,
  },
  warning: {
    wrap: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
    icon: AlertTriangle,
  },
  info: { wrap: 'border-brand-200 bg-brand-50 text-brand-800', icon: Info },
};

function ToastItem({ toast, onDismiss }: ItemProps): JSX.Element {
  const { wrap, icon: Icon } = TONE_STYLES[toast.tone];
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paused = useRef<boolean>(false);

  const startTimer = useCallback((): void => {
    if (toast.duration <= 0) return;
    timer.current = setTimeout(() => {
      if (!paused.current) onDismiss();
    }, toast.duration);
  }, [toast.duration, onDismiss]);

  useEffect(() => {
    startTimer();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [startTimer]);

  // Escape closes the most recent toast — handled at the viewport
  // level would race with focus traps; we attach to each item.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onDismiss();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      role="status"
      onMouseEnter={() => {
        paused.current = true;
        if (timer.current) clearTimeout(timer.current);
      }}
      onMouseLeave={() => {
        paused.current = false;
        startTimer();
      }}
      className={cn(
        'pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-lg backdrop-blur-sm',
        wrap,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex-1">
        <p className="font-semibold">{toast.title}</p>
        {toast.body ? <p className="mt-0.5 text-xs opacity-90">{toast.body}</p> : null}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className="text-current opacity-70 hover:opacity-100"
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
