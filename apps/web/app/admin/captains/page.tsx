'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, captainsApi, teamsApi } from '@/lib/api';
import type { Captain, CaptainStatus, Team } from '@/lib/api-types';

const STATUSES: readonly CaptainStatus[] = ['active', 'inactive', 'archived'] as const;

function statusTone(s: CaptainStatus): 'healthy' | 'inactive' {
  return s === 'active' ? 'healthy' : 'inactive';
}

/**
 * /admin/captains (C18) — read-only list of converted captains.
 *
 * Captains are created exclusively via the convert action on a lead, so
 * this page has no create / edit / delete affordances. It exposes the
 * three filters the API supports (team, status, free-text q) and lets
 * the operator click through to the originating lead via the back-link
 * shown on each row.
 */
export default function CaptainsPage(): JSX.Element {
  const t = useTranslations('admin.captains');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<Captain[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [filterTeamId, setFilterTeamId] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<CaptainStatus | ''>('');
  const [search, setSearch] = useState<string>('');

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [page, allTeams] = await Promise.all([
        captainsApi.list({
          teamId: filterTeamId || undefined,
          status: filterStatus || undefined,
          q: search.trim() || undefined,
          limit: 200,
        }),
        teamsApi.list().catch(() => [] as Team[]),
      ]);
      setRows(page.items);
      setTeams(allTeams);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filterTeamId, filterStatus, search]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const teamById = useMemo(() => new Map(teams.map((tm) => [tm.id, tm])), [teams]);

  const hasActiveFilter = Boolean(filterTeamId || filterStatus || search);
  const isEmpty = !loading && !error && rows.length === 0;

  const columns: ReadonlyArray<Column<Captain>> = [
    {
      key: 'name',
      header: t('name'),
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      key: 'phone',
      header: t('phone'),
      render: (r) => <code className="font-mono text-xs">{r.phone}</code>,
    },
    {
      key: 'team',
      header: t('team'),
      render: (r) =>
        r.teamId ? (
          (teamById.get(r.teamId)?.name ?? '—')
        ) : (
          <span className="text-ink-tertiary">{t('noTeam')}</span>
        ),
    },
    {
      key: 'status',
      header: t('status'),
      render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
    },
    {
      key: 'onboarding',
      header: t('onboardingStatus'),
      render: (r) => <span className="text-xs text-ink-secondary">{r.onboardingStatus}</span>,
    },
    {
      key: 'createdAt',
      header: tCommon('createdAt'),
      render: (r) => (
        <span className="text-xs text-ink-secondary">
          {new Date(r.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full max-w-xs">
          <Field label={t('filterByTeam')}>
            <Select value={filterTeamId} onChange={(e) => setFilterTeamId(e.target.value)}>
              <option value="">{tCommon('all')}</option>
              {teams.map((tm) => (
                <option key={tm.id} value={tm.id}>
                  {tm.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-xs">
          <Field label={t('filterByStatus')}>
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as CaptainStatus | '')}
            >
              <option value="">{tCommon('all')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-full max-w-sm">
          <Field label={t('search')}>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…" />
          </Field>
        </div>
      </div>

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

      {isEmpty ? (
        <EmptyState
          title={hasActiveFilter ? t('emptyFiltered') : t('empty')}
          body={hasActiveFilter ? t('emptyFilteredHint') : t('emptyHint')}
          action={
            hasActiveFilter ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setFilterTeamId('');
                  setFilterStatus('');
                  setSearch('');
                }}
              >
                {tCommon('clearFilters')}
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
          rowActions={(row) => (
            <Link
              href={`/admin/leads/${row.leadId}`}
              className="inline-flex h-8 items-center justify-center rounded-md border border-surface-border bg-surface-card px-3 text-xs font-medium text-ink-primary hover:bg-brand-50 hover:border-brand-200"
            >
              {t('openLead')}
            </Link>
          )}
        />
      )}
    </div>
  );
}
