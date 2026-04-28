import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

const fieldClasses =
  'block w-full rounded-md border border-surface-border bg-surface-card px-3 text-sm text-ink-primary ' +
  'placeholder:text-ink-tertiary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(fieldClasses, 'h-9', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea ref={ref} className={cn(fieldClasses, 'min-h-[80px] py-2', className)} {...rest} />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(fieldClasses, 'h-9 pe-8', className)} {...rest}>
        {children}
      </select>
    );
  },
);

export interface FieldProps {
  label: string;
  error?: string | null;
  hint?: string | null;
  required?: boolean;
  children: React.ReactNode;
}

export function Field({ label, error, hint, required, children }: FieldProps): JSX.Element {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-primary">
        {label}
        {required ? <span className="text-status-breach"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-ink-tertiary">{hint}</span> : null}
      {error ? <span className="text-xs text-status-breach">{error}</span> : null}
    </label>
  );
}
