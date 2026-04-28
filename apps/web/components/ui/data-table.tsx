import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Render the cell. */
  render: (row: T) => React.ReactNode;
  /** Tailwind alignment / width classes for the <td>. */
  className?: string;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  keyOf: (row: T) => string;
  loading?: boolean;
  emptyMessage?: string;
  /** Render extra cells to the right per row, e.g. action buttons. */
  rowActions?: (row: T) => React.ReactNode;
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  loading,
  emptyMessage = 'No records',
  rowActions,
}: DataTableProps<T>): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-surface-border text-sm">
          <thead className="bg-surface text-xs uppercase tracking-wide text-ink-secondary">
            <tr>
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
            {loading ? (
              <tr>
                <td
                  colSpan={columns.length + (rowActions ? 1 : 0)}
                  className="px-4 py-8 text-center text-ink-secondary"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (rowActions ? 1 : 0)}
                  className="px-4 py-8 text-center text-ink-secondary"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={keyOf(row)} className="hover:bg-brand-50/40">
                  {columns.map((c) => (
                    <td key={c.key} className={cn('px-4 py-2 align-middle', c.className)}>
                      {c.render(row)}
                    </td>
                  ))}
                  {rowActions ? (
                    <td className="px-4 py-2 text-end">
                      <div className="flex items-center justify-end gap-1.5">{rowActions(row)}</div>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
