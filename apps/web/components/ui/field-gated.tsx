'use client';

import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';

import { canEditField, canSeeField } from '@/lib/permissions';

/**
 * Phase C — C6: declarative field-permission wrapper.
 *
 * Two modes:
 *
 *   READ-mode (default)
 *     <FieldGated resource="lead" field="phone">
 *       <PhoneCell phone={lead.phone} />
 *     </FieldGated>
 *
 *     • When `canSeeField(resource, field)` is true → renders children unchanged.
 *     • When false → renders `fallback` (default: nothing). Use a
 *       small placeholder when the layout needs to keep its slot
 *       (e.g. a `—` cell in a table) — pass `fallback={<span>—</span>}`.
 *
 *   EDIT-mode (`mode="edit"`)
 *     <FieldGated resource="lead" field="assignedToId" mode="edit">
 *       <Select value={...} onChange={...}>…</Select>
 *     </FieldGated>
 *
 *     • When `canEditField` is true → renders children unchanged.
 *     • When false → clones the single child and adds `disabled`
 *       (and `readOnly` for inputs) so the UI tells the user the
 *       field is uneditable without unmounting it. The label,
 *       helper text and the field's current value remain visible
 *       (read access is independent of edit access).
 *
 * The server-side filter (C4 read / C5 write) is the security gate
 * regardless of what this component renders — this is UX guidance.
 *
 * Usage notes:
 *
 *   • Edit-mode supports a single child element only. The clone
 *     pattern doesn't make sense for fragments / arrays, so this
 *     restriction keeps the component predictable.
 *   • Read-mode happily wraps multiple children.
 *   • Both modes use the existing cached `/auth/me` payload via
 *     `permissions.ts` — no new fetches, no Suspense.
 */

export type FieldGatedMode = 'read' | 'edit';

interface FieldGatedProps {
  resource: string;
  field: string;
  /** read = hide vs render; edit = disable / readOnly. Default: read. */
  mode?: FieldGatedMode;
  /** Read-mode fallback when the field can't be seen. Default: null. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Edit-mode clones the single child element and adds:
 *   • `disabled` (for any element that supports it — buttons,
 *     selects, inputs)
 *   • `readOnly` (for text-like inputs — Input, Textarea)
 *   • `aria-disabled` (a11y signal for non-form children)
 *
 * The cloned child preserves its `value`, `onChange`, etc. — the
 * onChange is harmless because the input is also `disabled`/
 * `readOnly`, so the browser won't fire change events.
 */
function disableElement(child: ReactElement): ReactElement {
  const existingProps = child.props as Record<string, unknown>;
  const cloneProps: Record<string, unknown> = {
    disabled: true,
    'aria-disabled': true,
  };
  // Inputs / textareas / selects also accept readOnly. Adding it is
  // a no-op for elements that don't recognize the prop.
  if (existingProps['readOnly'] === undefined) {
    cloneProps['readOnly'] = true;
  }
  return cloneElement(child, cloneProps);
}

export function FieldGated({
  resource,
  field,
  mode = 'read',
  fallback = null,
  children,
}: FieldGatedProps): JSX.Element {
  if (mode === 'read') {
    return canSeeField(resource, field) ? <>{children}</> : <>{fallback}</>;
  }

  // edit mode — single child only.
  if (canEditField(resource, field)) {
    return <>{children}</>;
  }
  const arr = Children.toArray(children);
  if (arr.length !== 1 || !isValidElement(arr[0])) {
    // Fall back to passing children through; consumers using
    // edit-mode with multiple children should restructure to one
    // root element (the C7 form patterns will do this naturally).
    return <>{children}</>;
  }
  return disableElement(arr[0]);
}
