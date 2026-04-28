import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Tailwind-aware class composer. Combines `clsx` (conditional class lists)
 * with `tailwind-merge` (resolves conflicting Tailwind utility classes).
 *
 *   cn('px-2', condition && 'px-4')  →  'px-4'
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
