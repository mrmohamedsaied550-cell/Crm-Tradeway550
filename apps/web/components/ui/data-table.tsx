import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

/**
 * P3-06 — number of skeleton rows to render while `loading=true`. The
 * default keeps the legacy single-spinner behaviour; pages opt in by
 * passing a number.
 */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Render the cell. */
  render: (row: T) => React.ReactNode;
  /** Tailwind alignment / width classes for the <td>. */
  className?: string;
}

/**
 * P3-05 — opt-in multi-select. When `selection` is passed, the table
 * renders a leading checkbox column. The header checkbox toggles
 * every row currently visible (NOT the whole dataset — paged rows
 * stay untouched). The selection state lives outside the table so
 * the parent owns "what is the bulk action targeting".
 */
export interface DataTableSelection {
  selectedIds: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** Optional aria-label override for the checkboxes. */
  ariaLabel?: string;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  keyOf: (row: T) => string;
  loading?: boolean;
  /** P3-06 — render N skeleton rows while loading instead of a single spinner. */
  skeletonRows?: number;
  emptyMessage?: string;
  /** Render extra cells to the right per row, e.g. action buttons. */
  rowActions?: (row: T) => React.ReactNode;
  selection?: DataTableSelection;
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  loading,
  skeletonRows,
  emptyMessage = 'No records',
  rowActions,
  selection,
}: DataTableProps<T>): JSX.Element {
  const colCount = columns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0);
  const visibleIds = rows.map((r) => keyOf(r));
  const allChecked =
    selection !== undefined &&
    rows.length > 0 &&
    visibleIds.every((id) => selection.selectedIds.has(id));
  const someChecked =
    selection !== undefined &&
    !allChecked &&
    visibleIds.some((id) => selection.selectedIds.has(id));

  function toggleAll(): void {
    if (!selection) return;
    const next = new Set(selection.selectedIds);
    if (allChecked) {
      for (const id of visibleIds) next.delete(id);
    } else {
      for (const id of visibleIds) next.add(id);
    }
    selection.onChange(next);
  }

  function toggleOne(id: string): void {
    if (!selection) return;
    const next = new Set(selection.selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection.onChange(next);
  }

  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-border text-sm">
          <thead className="bg-surface text-xs uppercase tracking-wide text-ink-secondary">
            <tr>
              {selection ? (
                <th scope="col" className="w-10 px-4 py-2 text-start font-medium">
                  <input
                    type="checkbox"
                    aria-label={selection.ariaLabel ?? 'Select all visible'}
                    checked={allChecked}
                    ref={(el) => {
                      if (el) el.indeterminate = someChecked;
                    }}
                    onChange={toggleAll}
                  />
                </th>
              ) : null}
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn('px-4 py-2 text-start font-medium', c.className)}
                  scope="col"
                >
                  {c.header}
                </th>
              ))}
              {rowActions ? <th className="px-4 py-2 text-end font-medium">&nbsp;</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {loading && skeletonRows && skeletonRows > 0 ? (
              // P3-06 — placeholder rows so the layout doesn't collapse to
              // a single-line spinner. Width nudge per column makes the
              // pattern look like real content.
              Array.from({ length: skeletonRows }).map((_, i) => (
                <tr key={`__skeleton_${i}`} aria-hidden="true">
                  {selection ? (
                    <td className="w-10 px-4 py-3 align-middle">
                      <span className="block h-4 w-4 animate-pulse rounded bg-surface-border/60" />
                    </td>
                  ) : null}
                  {columns.map((c, j) => (
                    <td key={c.key} className="px-4 py-3 align-middle">
                      <span
                        className={cn(
                          'block h-3 animate-pulse rounded bg-surface-border/60',
                          j % 3 === 0 ? 'w-1/2' : j % 3 === 1 ? 'w-3/4' : 'w-1/3',
                        )}
                      />
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="px-4 py-3 text-end">
                      <span className="ms-auto inline-block h-3 w-12 animate-pulse rounded bg-surface-border/60" />
                    </td>
                  ) : null}
                </tr>
              ))
            ) : loading ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-ink-secondary">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="px-4 py-8 text-center text-ink-secondary">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const id = keyOf(row);
                const checked = selection?.selectedIds.has(id) ?? false;
                return (
                  <tr
                    key={id}
                    className={cn(
                      'hover:bg-brand-50/40',
                      selection && checked ? 'bg-brand-50/40' : '',
                    )}
                  >
                    {selection ? (
                      <td className="w-10 px-4 py-2 align-middle">
                        <input
                          type="checkbox"
                          aria-label={selection.ariaLabel ?? 'Select row'}
                          checked={checked}
                          onChange={() => toggleOne(id)}
                        />
                      </td>
                    ) : null}
                    {columns.map((c) => (
                      <td key={c.key} className={cn('px-4 py-2 align-middle', c.className)}>
                        {c.render(row)}
                      </td>
                    ))}
                    {rowActions ? (
                      <td className="px-4 py-2 text-end">
                        <div className="flex items-center justify-end gap-1.5">
                          {rowActions(row)}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
