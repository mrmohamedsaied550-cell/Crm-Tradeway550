'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { NewFacebookIntegrationModal } from '@/components/admin/meta-lead-sources/new-facebook-integration-modal';
import { ApiError, metaLeadSourcesApi } from '@/lib/api';
import type { MetaLeadSource } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * /admin/meta-lead-sources (P2-06 + Sprint M2 / Phase 3) — admin list
 * of OAuth-driven Meta Lead Ads integrations.
 *
 * The legacy JSON-textarea form has been replaced by the guided
 * `NewFacebookIntegrationModal` wizard: Connect with Facebook ->
 * Project / Channel / Campaign / Page / Form cascade -> field
 * mapping picker -> Save. Existing rows are still listed here for
 * visibility and can be deleted; edits require recreation (the
 * underlying service still supports PATCH for callers that want it).
 *
 * Capability gate (server-side):
 *   - meta.leadsource.read  for the list,
 *   - meta.leadsource.write for create / delete.
 */
export default function MetaLeadSourcesPage(): JSX.Element {
  const t = useTranslations('admin.metaLeadSources');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();
  const canWrite = hasCapability('meta.leadsource.write');

  const [rows, setRows] = useState<MetaLeadSource[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean>(false);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const items = await metaLeadSourcesApi.list();
      setRows(items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function openCreate(): void {
    setOpen(true);
  }

  async function onDelete(row: MetaLeadSource): Promise<void> {
    if (!window.confirm(t('confirmDelete', { name: row.displayName }))) return;
    try {
      await metaLeadSourcesApi.remove(row.id);
      toast({ tone: 'success', title: t('deleted') });
      await reload();
    } catch (err) {
      toast({ tone: 'error', title: err instanceof ApiError ? err.message : String(err) });
    }
  }

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [],
  );

  const columns: ReadonlyArray<Column<MetaLeadSource>> = useMemo(
    () => [
      {
        key: 'title',
        header: t('cols.title'),
        render: (r) => (
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate font-medium text-ink-primary" title={r.displayName}>
              {r.displayName}
            </span>
            {r.pageName ? (
              <span className="truncate text-xs text-ink-tertiary" title={r.pageName}>
                {r.pageName}
              </span>
            ) : null}
            {!r.isActive ? (
              <span className="mt-1">
                <Badge tone="inactive">{t('cols.inactive')}</Badge>
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'channel',
        header: t('cols.channel'),
        render: (r) =>
          r.channel ? (
            <span className="text-sm text-ink-primary">{r.channel}</span>
          ) : (
            <span className="text-xs text-ink-tertiary">—</span>
          ),
      },
      {
        key: 'project',
        header: t('cols.project'),
        render: (r) =>
          r.project ? (
            <span className="text-sm text-ink-primary">{r.project}</span>
          ) : (
            <span className="text-xs text-ink-tertiary">—</span>
          ),
      },
      {
        key: 'formId',
        header: t('cols.formId'),
        render: (r) =>
          r.formId ? (
            <span className="font-mono text-xs text-ink-secondary" title={r.formId}>
              {r.formId}
            </span>
          ) : (
            <span className="text-xs text-ink-tertiary">—</span>
          ),
      },
      {
        key: 'updatedAt',
        header: t('cols.lastActivity'),
        render: (r) => (
          <span className="text-xs text-ink-secondary" title={new Date(r.updatedAt).toISOString()}>
            {dateFormatter.format(new Date(r.updatedAt))}
          </span>
        ),
      },
    ],
    [t, dateFormatter],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite ? (
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              {t('newButton')}
            </Button>
          ) : null
        }
      />

      <Notice tone="info">{t('webhookHint')}</Notice>

      {error ? (
        <Notice tone="error">
          <div className="flex items-start justify-between gap-3">
            <span>{error}</span>
            <Button variant="ghost" size="sm" onClick={() => void reload()}>
              {tCommon('retry')}
            </Button>
          </div>
        </Notice>
      ) : null}

      {!loading && rows.length === 0 ? (
        <EmptyState
          title={t('empty')}
          body={t('emptyHint')}
          action={
            canWrite ? (
              <Button variant="secondary" size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" />
                {t('newButton')}
              </Button>
            ) : null
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          keyOf={(r) => r.id}
          loading={loading}
          skeletonRows={4}
          rowActions={(row) =>
            canWrite ? (
              <Button variant="ghost" size="sm" onClick={() => void onDelete(row)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            ) : null
          }
        />
      )}

      <NewFacebookIntegrationModal
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          toast({ tone: 'success', title: t('created') });
          void reload();
        }}
      />
    </div>
  );
}
