'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Circle,
  Crown,
  Globe,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserCog,
  Users2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import {
  ApiError,
  companiesApi,
  countriesApi,
  presenceApi,
  rolesApi,
  teamsApi,
  usersApi,
  type OtherPresenceRow,
} from '@/lib/api';
import { hasCapability } from '@/lib/auth';
import { cn } from '@/lib/utils';
import type {
  AdminUser,
  Company,
  Country,
  RoleSummary,
  Team,
  UserScopeAssignmentsForUser,
  UserScopeCount,
} from '@/lib/api-types';

/**
 * Sprint 6 — Organization / Headcount unified control center.
 *
 * One page that owns the full Company → Country → Team → Users
 * hierarchy, capability/scope quality, and operational headcount.
 * Replaces the fragmented Companies / Countries / Teams / Users /
 * Roles primary-nav entries (those still exist as Advanced
 * routes; this page is the new primary surface).
 *
 * Page layout (top → bottom):
 *
 *   1. Header summary — title, subtitle, quick-action buttons
 *      (Add Company / Country / Team / User / Advanced Admin).
 *      Each quick-action links into the existing admin page that
 *      already owns the create flow; we don't duplicate the
 *      modals here. Quick-actions are gated by their respective
 *      capabilities (`org.*.write`, `users.write`).
 *
 *   2. KPI overview cards — Companies / Countries / Teams /
 *      Users / Active users / Online users (presence gap) +
 *      data-quality counters (no team / no role / no scope /
 *      teams without TL / etc.). Each KPI card is clickable
 *      where it maps to a filter; the not-yet-wired ones are
 *      static counts only.
 *
 *   3. Data quality / setup issues — one row per detected
 *      issue with affected records + the right deep link.
 *      Renders nothing when everything's clean.
 *
 *   4. Organization tree — expandable Company → Country → Team
 *      cards, each showing team leader, user count, and missing-
 *      setup chips. Click into a team row → /admin/teams (the
 *      Advanced page) to edit.
 *
 *   5. People table — flat user list with role / team / scope /
 *      status / missing-setup chips. Click → /admin/users for
 *      edits today; future iteration can inline-edit here.
 *
 *   6. Advanced admin links — Companies / Countries / Teams /
 *      Users / Roles as a card row at the bottom so power users
 *      can still jump into the matrix views directly.
 *
 * Permission posture:
 *   - The page itself is gated by `org.company.read` (matches the
 *     sidebar entry's gate). Sub-sections also self-gate: people
 *     table requires `users.read`; quick-action buttons require
 *     the corresponding write capability.
 *   - `safeFetch` swallows per-endpoint 403s so a capability gap
 *     never blanks the whole page — the affected section shows
 *     its own no-access state.
 *
 * Presence:
 *   - Sprint 6 spec calls for online/away/offline/busy chips.
 *     There's no presence engine wired yet; the Online users KPI
 *     renders a "presence tracking not enabled" hint, and user
 *     rows omit the chip rather than faking it. Once a presence
 *     signal lands the chip slot is already in place.
 *
 * Logos / avatars:
 *   - No Branding & Asset Settings model today. Initials avatars
 *     for users + name-initial chips for companies. A clear gap
 *     note explains the Sprint 7+ direction.
 *
 * Reused APIs (no new endpoints):
 *   - companiesApi.list
 *   - countriesApi.list
 *   - teamsApi.list
 *   - usersApi.list ({ limit: 200 })
 *   - rolesApi.list
 *
 * The page is a `'use client'` component with parallel fetches.
 * Each fetch is independent so partial failures degrade
 * gracefully.
 */

interface DataState {
  companies: readonly Company[];
  countries: readonly Country[];
  teams: readonly Team[];
  users: readonly AdminUser[];
  roles: readonly RoleSummary[];
  /** Sprint 8 (D8) — bulk scope counts indexed by userId. */
  scopeCounts: ReadonlyMap<string, UserScopeCount>;
  /** Sprint 8 (D8) — bulk scope assignments indexed by userId. */
  scopeAssignments: ReadonlyMap<string, UserScopeAssignmentsForUser>;
  /** True when scope data couldn't be loaded (e.g. capability denied). */
  scopeUnavailable: boolean;
  /** Sprint 10 (D10) — per-user presence indexed by userId. */
  presenceByUser: ReadonlyMap<string, OtherPresenceRow>;
  /** Sprint 10 (D10) — true when the presence endpoint failed (auth/network). */
  presenceUnavailable: boolean;
  /** Sprint 10 (D10) — count of users currently online (status === 'online'). */
  onlineCount: number;
}

const EMPTY_DATA: DataState = {
  companies: [],
  countries: [],
  teams: [],
  users: [],
  roles: [],
  scopeCounts: new Map(),
  scopeAssignments: new Map(),
  scopeUnavailable: false,
  presenceByUser: new Map(),
  presenceUnavailable: false,
  onlineCount: 0,
};

/**
 * Sprint 8 — TL detection now reads the persisted
 * `Role.isTeamLeader` flag. The flag was backfilled in
 * 0046_d8_role_is_team_leader using the same heuristic the UI
 * carried in Sprints 6 + 7 (`code LIKE 'tl_%' OR level >= 70`),
 * so behaviour at cutover is identical. Any future admin edit of
 * the flag goes through the existing role write surface with D5
 * risk preview.
 */
function isTeamLeaderRole(role: RoleSummary | undefined): boolean {
  return Boolean(role?.isTeamLeader);
}

export default function OrganizationPage(): JSX.Element {
  const t = useTranslations('admin.organization');
  const tCommon = useTranslations('admin.common');
  const tNav = useTranslations('admin.sideNav');

  const [data, setData] = useState<DataState>(EMPTY_DATA);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Tree-row expansion state. Keyed by `${level}:${id}`.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // 6.1 — In-page People filter so KPI cards / issue rows can deep-link
  // into the affected user subset without leaving the page or depending
  // on a not-yet-wired ?filter param on /admin/users.
  type PeopleFilter = 'all' | 'noTeam' | 'noRole';
  const [peopleFilter, setPeopleFilter] = useState<PeopleFilter>('all');

  // 6.1 — RBAC capability snapshot. Read once on mount and on every
  // refresh so the gates re-evaluate after a re-login / role change.
  const canReadUsers = hasCapability('users.read');
  const canWriteUsers = hasCapability('users.write');
  const canWriteTeam = hasCapability('org.team.write');
  const canReadCompanies = hasCapability('org.company.read');
  const canReadCountries = hasCapability('org.country.read');
  const canReadTeams = hasCapability('org.team.read');
  const canReadRoles = hasCapability('roles.read');
  const isReadOnly =
    !hasCapability('org.company.write') &&
    !hasCapability('org.country.write') &&
    !hasCapability('org.team.write') &&
    !hasCapability('users.write');

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Sprint 8 — scope endpoints are tagged so we can distinguish
      // "endpoint failed" from "no rows" and surface the right gap
      // state without faking numbers.
      const SCOPE_FAIL = Symbol('scope-fail');
      const safeFetch = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
      const safeScope = async <T,>(p: Promise<T>): Promise<T | typeof SCOPE_FAIL> => {
        try {
          return await p;
        } catch {
          return SCOPE_FAIL;
        }
      };

      const [companies, countries, teams, userPage, roles] = await Promise.all([
        safeFetch(companiesApi.list(), [] as Company[]),
        safeFetch(countriesApi.list(), [] as Country[]),
        safeFetch(teamsApi.list(), [] as Team[]),
        safeFetch(usersApi.list({ limit: 200 }), {
          items: [] as AdminUser[],
          total: 0,
          limit: 200,
          offset: 0,
        }),
        safeFetch(rolesApi.list(), [] as RoleSummary[]),
      ]);

      // Sprint 8 — bulk scope fetches happen AFTER the user list
      // resolves so we can scope the assignments call to visible
      // ids only. scope-counts is unfiltered (whole tenant view);
      // scope-assignments needs ids, capped at 200 per request.
      // Sprint 10 — presence is fetched in the same parallel batch
      // (one bulk call against the visible user list).
      const visibleUserIds = userPage.items.map((u) => u.id);
      const [scopeCountsResp, scopeAssignmentsResp, presenceResp] = await Promise.all([
        safeScope(usersApi.listScopeCounts({})),
        visibleUserIds.length > 0
          ? safeScope(usersApi.listScopeAssignmentsBulk({ ids: visibleUserIds }))
          : Promise.resolve({ items: [] }),
        visibleUserIds.length > 0
          ? safeScope(presenceApi.listForUsers({ ids: visibleUserIds }))
          : Promise.resolve({ items: [] }),
      ]);

      const scopeUnavailable =
        scopeCountsResp === SCOPE_FAIL || scopeAssignmentsResp === SCOPE_FAIL;
      const scopeCounts = new Map<string, UserScopeCount>();
      if (scopeCountsResp !== SCOPE_FAIL) {
        for (const row of scopeCountsResp.items) scopeCounts.set(row.userId, row);
      }
      const scopeAssignments = new Map<string, UserScopeAssignmentsForUser>();
      if (scopeAssignmentsResp !== SCOPE_FAIL) {
        for (const row of scopeAssignmentsResp.items) scopeAssignments.set(row.userId, row);
      }
      // Sprint 10 — presence map indexed by userId. The KPI count
      // comes directly from items where status === 'online'; users
      // that don't appear in the response are treated as offline.
      const presenceByUser = new Map<string, OtherPresenceRow>();
      const presenceUnavailable = presenceResp === SCOPE_FAIL;
      let onlineCount = 0;
      if (presenceResp !== SCOPE_FAIL) {
        for (const row of presenceResp.items) {
          presenceByUser.set(row.userId, row);
          if (row.status === 'online') onlineCount += 1;
        }
      }

      setData({
        companies,
        countries,
        teams,
        users: userPage.items,
        roles,
        scopeCounts,
        scopeAssignments,
        scopeUnavailable,
        presenceByUser,
        presenceUnavailable,
        onlineCount,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ─────────────────────────────────────────────────────────
  //  Derived: counts, lookups, issues
  // ─────────────────────────────────────────────────────────

  const rolesById = useMemo(() => {
    const m = new Map<string, RoleSummary>();
    for (const r of data.roles) m.set(r.id, r);
    return m;
  }, [data.roles]);

  const teamsByCountry = useMemo(() => {
    const m = new Map<string, Team[]>();
    for (const t of data.teams) {
      const arr = m.get(t.countryId) ?? [];
      arr.push(t);
      m.set(t.countryId, arr);
    }
    return m;
  }, [data.teams]);

  const countriesByCompany = useMemo(() => {
    const m = new Map<string, Country[]>();
    for (const c of data.countries) {
      const arr = m.get(c.companyId) ?? [];
      arr.push(c);
      m.set(c.companyId, arr);
    }
    return m;
  }, [data.countries]);

  const usersByTeam = useMemo(() => {
    const m = new Map<string, AdminUser[]>();
    for (const u of data.users) {
      if (!u.teamId) continue;
      const arr = m.get(u.teamId) ?? [];
      arr.push(u);
      m.set(u.teamId, arr);
    }
    return m;
  }, [data.users]);

  const counts = useMemo(() => {
    const activeUsers = data.users.filter((u) => u.status === 'active').length;
    const usersWithoutTeam = data.users.filter((u) => !u.teamId).length;
    const usersWithoutRole = data.users.filter((u) => !u.roleId).length;
    const teamsWithoutTl = data.teams.filter((tm) => {
      const usersInTeam = usersByTeam.get(tm.id) ?? [];
      return !usersInTeam.some((u) => isTeamLeaderRole(rolesById.get(u.roleId)));
    }).length;
    const teamsWithoutUsers = data.teams.filter(
      (tm) => (usersByTeam.get(tm.id) ?? []).length === 0,
    ).length;
    const countriesWithoutTeams = data.countries.filter(
      (c) => (teamsByCountry.get(c.id) ?? []).length === 0,
    ).length;
    const companiesWithoutCountries = data.companies.filter(
      (c) => (countriesByCompany.get(c.id) ?? []).length === 0,
    ).length;
    // Sprint 8 — real "users without scope" derived from the bulk
    // scope-counts endpoint. `null` means the endpoint failed (we
    // surface that as a no-access notice on the KPI instead of a
    // zero).
    const usersWithoutScope: number | null = data.scopeUnavailable
      ? null
      : data.scopeCounts.size === 0
        ? 0
        : Array.from(data.scopeCounts.values()).filter((c) => !c.hasAnyScope).length;
    return {
      companies: data.companies.length,
      countries: data.countries.length,
      teams: data.teams.length,
      users: data.users.length,
      activeUsers,
      usersWithoutTeam,
      usersWithoutRole,
      usersWithoutScope,
      teamsWithoutTl,
      teamsWithoutUsers,
      countriesWithoutTeams,
      companiesWithoutCountries,
    };
  }, [data, usersByTeam, teamsByCountry, countriesByCompany, rolesById]);

  // ─────────────────────────────────────────────────────────
  //  Render helpers
  // ─────────────────────────────────────────────────────────

  function toggle(key: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // 6.1 — Focus People table and apply a filter in one click.
  function focusPeople(filter: PeopleFilter): void {
    setPeopleFilter(filter);
    if (typeof window !== 'undefined') {
      const el = document.getElementById('org-people');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ─────── render ───────

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {isReadOnly ? (
              <Badge tone="neutral" aria-label={t('readOnly')}>
                {t('readOnly')}
              </Badge>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={loading}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {tCommon('refresh')}
            </Button>
            <QuickActionLink
              href="/admin/companies"
              cap="org.company.write"
              label={t('quickActions.addCompany')}
            />
            <QuickActionLink
              href="/admin/countries"
              cap="org.country.write"
              label={t('quickActions.addCountry')}
            />
            <QuickActionLink
              href="/admin/teams"
              cap="org.team.write"
              label={t('quickActions.addTeam')}
            />
            <QuickActionLink
              href="/admin/users"
              cap="users.write"
              label={t('quickActions.addUser')}
            />
          </div>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* ─── KPI Overview ─── */}
      <section aria-labelledby="org-kpis" className="flex flex-col gap-3">
        <h2
          id="org-kpis"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('sections.kpis')}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label={t('kpis.companies')}
            count={counts.companies}
            icon={Building2}
            href={canReadCompanies ? '/admin/companies' : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.countries')}
            count={counts.countries}
            icon={Globe}
            href={canReadCountries ? '/admin/countries' : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.teams')}
            count={counts.teams}
            icon={Users2}
            href={canReadTeams ? '/admin/teams' : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.users')}
            count={counts.users}
            icon={UserCog}
            href={canReadUsers ? '/admin/users' : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.activeUsers')}
            count={counts.activeUsers}
            icon={UserCog}
            tone="healthy"
            href={canReadUsers ? '/admin/users' : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.onlineUsers')}
            count={data.presenceUnavailable ? null : data.onlineCount}
            icon={Circle}
            tone={
              data.presenceUnavailable ? 'neutral' : data.onlineCount > 0 ? 'healthy' : 'neutral'
            }
            hint={data.presenceUnavailable ? t('presenceUnavailable') : undefined}
            loading={loading}
          />
          <KpiCard
            label={t('kpis.usersWithoutTeam')}
            count={counts.usersWithoutTeam}
            icon={AlertTriangle}
            tone={counts.usersWithoutTeam > 0 ? 'warning' : 'healthy'}
            onClick={
              canReadUsers && counts.usersWithoutTeam > 0 ? () => focusPeople('noTeam') : undefined
            }
            loading={loading}
          />
          <KpiCard
            label={t('kpis.usersWithoutScope')}
            count={counts.usersWithoutScope}
            icon={AlertTriangle}
            tone={
              counts.usersWithoutScope === null
                ? 'neutral'
                : counts.usersWithoutScope > 0
                  ? 'warning'
                  : 'healthy'
            }
            hint={counts.usersWithoutScope === null ? t('scopeUnavailable') : undefined}
            loading={loading}
          />
        </ul>
      </section>

      {/* ─── Data quality issues ─── */}
      <section aria-labelledby="org-issues" className="flex flex-col gap-3">
        <h2
          id="org-issues"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('sections.issues')}
        </h2>
        <DataQualityList
          counts={counts}
          canReadUsers={canReadUsers}
          onFocusPeople={focusPeople}
          t={t}
        />
      </section>

      {/* ─── Organization tree ─── */}
      <section aria-labelledby="org-tree" className="flex flex-col gap-3">
        <h2
          id="org-tree"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('sections.tree')}
        </h2>
        {data.companies.length === 0 ? (
          <Notice tone="info">
            <p className="text-sm font-medium">{t('tree.empty.title')}</p>
            <p className="mt-1 text-xs text-ink-secondary">{t('tree.empty.body')}</p>
          </Notice>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.companies.map((company) => {
              const countries = countriesByCompany.get(company.id) ?? [];
              const expandedKey = `company:${company.id}`;
              const isExpanded = expanded.has(expandedKey);
              return (
                <li
                  key={company.id}
                  className="rounded-lg border border-surface-border bg-surface-card shadow-card"
                >
                  <button
                    type="button"
                    onClick={() => toggle(expandedKey)}
                    className="flex w-full items-center gap-3 p-4 text-start transition-colors hover:bg-brand-50"
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
                    )}
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-50 text-[11px] font-semibold text-brand-700">
                      {company.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-medium text-ink-primary">{company.name}</span>
                      <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">
                        {company.code}
                      </span>
                    </div>
                    <Badge tone="neutral">
                      {t('tree.countriesCount', { n: countries.length })}
                    </Badge>
                    {countries.length === 0 ? (
                      <Badge tone="warning">{t('issues.noCountries')}</Badge>
                    ) : null}
                  </button>
                  {isExpanded ? (
                    <CountryList
                      countries={countries}
                      teamsByCountry={teamsByCountry}
                      usersByTeam={usersByTeam}
                      rolesById={rolesById}
                      expanded={expanded}
                      toggle={toggle}
                      canWriteTeam={canWriteTeam}
                      t={t}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ─── People table ─── */}
      <section aria-labelledby="org-people" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="org-people"
            className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
          >
            {t('sections.people')}
          </h2>
          {canReadUsers ? (
            <div
              role="tablist"
              aria-label={t('people.filters.label')}
              className="inline-flex items-center gap-1 rounded-md border border-surface-border bg-surface-card p-0.5 text-xs"
            >
              <PeopleFilterTab
                active={peopleFilter === 'all'}
                onClick={() => setPeopleFilter('all')}
                label={t('people.filters.all', { n: data.users.length })}
              />
              <PeopleFilterTab
                active={peopleFilter === 'noTeam'}
                onClick={() => setPeopleFilter('noTeam')}
                label={t('people.filters.noTeam', { n: counts.usersWithoutTeam })}
                tone={counts.usersWithoutTeam > 0 ? 'warning' : 'neutral'}
              />
              <PeopleFilterTab
                active={peopleFilter === 'noRole'}
                onClick={() => setPeopleFilter('noRole')}
                label={t('people.filters.noRole', { n: counts.usersWithoutRole })}
                tone={counts.usersWithoutRole > 0 ? 'warning' : 'neutral'}
              />
            </div>
          ) : null}
        </div>
        <PeopleTable
          users={data.users}
          teams={data.teams}
          rolesById={rolesById}
          filter={peopleFilter}
          canEdit={canWriteUsers}
          scopeAssignments={data.scopeAssignments}
          scopeUnavailable={data.scopeUnavailable}
          presenceByUser={data.presenceByUser}
          presenceUnavailable={data.presenceUnavailable}
          t={t}
        />
      </section>

      {/* ─── Advanced admin links ─── */}
      <section aria-labelledby="org-advanced" className="flex flex-col gap-3">
        <h2
          id="org-advanced"
          className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary"
        >
          {t('sections.advanced')}
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {canReadCompanies ? (
            <AdvancedLink href="/admin/companies" label={tNav('companies')} icon={Building2} />
          ) : null}
          {canReadCountries ? (
            <AdvancedLink href="/admin/countries" label={tNav('countries')} icon={Globe} />
          ) : null}
          {canReadTeams ? (
            <AdvancedLink href="/admin/teams" label={tNav('teams')} icon={Users2} />
          ) : null}
          {canReadUsers ? (
            <AdvancedLink href="/admin/users" label={tNav('users')} icon={UserCog} />
          ) : null}
          {canReadRoles ? (
            <AdvancedLink href="/admin/roles" label={tNav('roles')} icon={ShieldCheck} />
          ) : null}
        </ul>
        {!canReadCompanies &&
        !canReadCountries &&
        !canReadTeams &&
        !canReadUsers &&
        !canReadRoles ? (
          <Notice tone="info">
            <p className="text-sm font-medium">{t('advanced.noAccess')}</p>
          </Notice>
        ) : null}
      </section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────

function QuickActionLink({
  href,
  cap,
  label,
}: {
  href: string;
  cap: 'org.company.write' | 'org.country.write' | 'org.team.write' | 'users.write';
  label: string;
}): JSX.Element | null {
  if (!hasCapability(cap)) return null;
  return (
    <Link
      href={href}
      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-3 text-sm font-medium text-ink-primary transition-colors hover:border-brand-200 hover:bg-brand-50"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </Link>
  );
}

function KpiCard({
  label,
  count,
  icon: Icon,
  tone = 'info',
  href,
  onClick,
  hint,
  loading,
}: {
  label: string;
  count: number | null;
  icon: typeof Building2;
  tone?: 'healthy' | 'warning' | 'breach' | 'info' | 'neutral';
  href?: string;
  onClick?: () => void;
  hint?: string;
  loading: boolean;
}): JSX.Element {
  const toneClasses = {
    healthy: 'border-status-healthy/30 bg-status-healthy/5 text-status-healthy',
    warning: 'border-status-warning/30 bg-status-warning/5 text-status-warning',
    breach: 'border-status-breach/30 bg-status-breach/5 text-status-breach',
    info: 'border-status-info/30 bg-status-info/5 text-status-info',
    neutral: 'border-surface-border bg-surface-card text-ink-secondary',
  } as const;
  const interactive = Boolean(href || onClick);
  const inner = (
    <div
      className={cn(
        'flex h-full flex-col gap-2 rounded-lg border bg-surface-card p-4 shadow-card transition-colors',
        interactive ? 'hover:border-brand-200 hover:bg-brand-50' : '',
        toneClasses[tone].split(' ')[0],
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'inline-flex h-8 w-8 items-center justify-center rounded-md',
            toneClasses[tone],
          )}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink-primary">{label}</span>
        <span className="text-2xl font-semibold text-ink-primary">
          {loading ? <span className="text-ink-tertiary">…</span> : count === null ? '—' : count}
        </span>
      </div>
      {hint ? <p className="text-[11px] leading-snug text-ink-tertiary">{hint}</p> : null}
    </div>
  );
  if (href) {
    return (
      <li>
        <Link href={href}>{inner}</Link>
      </li>
    );
  }
  if (onClick) {
    return (
      <li>
        <button type="button" onClick={onClick} className="block w-full text-start">
          {inner}
        </button>
      </li>
    );
  }
  return <li>{inner}</li>;
}

function DataQualityList({
  counts,
  canReadUsers,
  onFocusPeople,
  t,
}: {
  counts: {
    usersWithoutTeam: number;
    usersWithoutRole: number;
    usersWithoutScope: number | null;
    teamsWithoutTl: number;
    teamsWithoutUsers: number;
    countriesWithoutTeams: number;
    companiesWithoutCountries: number;
  };
  canReadUsers: boolean;
  onFocusPeople: (filter: 'noTeam' | 'noRole') => void;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  type IssueRow =
    | { key: 'usersWithoutTeam' | 'usersWithoutRole'; n: number; filter: 'noTeam' | 'noRole' }
    | {
        key:
          | 'teamsWithoutTl'
          | 'teamsWithoutUsers'
          | 'countriesWithoutTeams'
          | 'companiesWithoutCountries';
        n: number;
        href: string;
      };
  const issues: readonly IssueRow[] = [
    { key: 'usersWithoutTeam', n: counts.usersWithoutTeam, filter: 'noTeam' },
    { key: 'usersWithoutRole', n: counts.usersWithoutRole, filter: 'noRole' },
    { key: 'teamsWithoutTl', n: counts.teamsWithoutTl, href: '/admin/teams' },
    { key: 'teamsWithoutUsers', n: counts.teamsWithoutUsers, href: '/admin/teams' },
    { key: 'countriesWithoutTeams', n: counts.countriesWithoutTeams, href: '/admin/countries' },
    {
      key: 'companiesWithoutCountries',
      n: counts.companiesWithoutCountries,
      href: '/admin/companies',
    },
  ];
  const active = issues.filter((i) => i.n > 0);
  if (active.length === 0) {
    return (
      <Notice tone="success">
        <p className="text-sm font-medium">{t('issues.allClear')}</p>
      </Notice>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {active.map((i) => {
        const label = (
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-status-warning" aria-hidden="true" />
            <span className="text-sm font-medium text-ink-primary">
              {t(`issues.${i.key}` as 'issues.usersWithoutTeam', { n: i.n })}
            </span>
          </span>
        );
        const arrow = <ArrowRight className="h-4 w-4 text-status-warning" aria-hidden="true" />;
        const cls =
          'flex w-full items-center justify-between gap-3 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-start transition-colors hover:border-status-warning/50';
        if ('filter' in i) {
          if (!canReadUsers) {
            return (
              <li key={i.key}>
                <div className={cn(cls, 'cursor-not-allowed opacity-70')} aria-disabled="true">
                  {label}
                </div>
              </li>
            );
          }
          return (
            <li key={i.key}>
              <button type="button" onClick={() => onFocusPeople(i.filter)} className={cls}>
                {label}
                {arrow}
              </button>
            </li>
          );
        }
        return (
          <li key={i.key}>
            <Link href={i.href} className={cls}>
              {label}
              {arrow}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function CountryList({
  countries,
  teamsByCountry,
  usersByTeam,
  rolesById,
  expanded,
  toggle,
  canWriteTeam,
  t,
}: {
  countries: readonly Country[];
  teamsByCountry: Map<string, Team[]>;
  usersByTeam: Map<string, AdminUser[]>;
  rolesById: Map<string, RoleSummary>;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  canWriteTeam: boolean;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  if (countries.length === 0) {
    return (
      <div className="border-t border-surface-border p-3 text-xs text-ink-tertiary">
        {t('tree.noCountries')}
      </div>
    );
  }
  return (
    <ul className="border-t border-surface-border">
      {countries.map((country) => {
        const teams = teamsByCountry.get(country.id) ?? [];
        const expandedKey = `country:${country.id}`;
        const isExpanded = expanded.has(expandedKey);
        return (
          <li key={country.id} className="border-b border-surface-border last:border-b-0">
            <button
              type="button"
              onClick={() => toggle(expandedKey)}
              className="flex w-full items-center gap-3 p-3 ps-10 text-start transition-colors hover:bg-brand-50"
              aria-expanded={isExpanded}
            >
              {isExpanded ? (
                <ChevronDown className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
              )}
              <Globe className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-ink-primary">{country.name}</span>
                <span className="text-[11px] uppercase tracking-wide text-ink-tertiary">
                  {country.code}
                </span>
              </div>
              <Badge tone="neutral">{t('tree.teamsCount', { n: teams.length })}</Badge>
              {teams.length === 0 ? <Badge tone="warning">{t('issues.noTeams')}</Badge> : null}
            </button>
            {isExpanded ? (
              <TeamList
                teams={teams}
                usersByTeam={usersByTeam}
                rolesById={rolesById}
                canWriteTeam={canWriteTeam}
                t={t}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function TeamList({
  teams,
  usersByTeam,
  rolesById,
  canWriteTeam,
  t,
}: {
  teams: readonly Team[];
  usersByTeam: Map<string, AdminUser[]>;
  rolesById: Map<string, RoleSummary>;
  canWriteTeam: boolean;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  if (teams.length === 0) {
    return (
      <div className="border-t border-surface-border p-3 ps-16 text-xs text-ink-tertiary">
        {t('tree.noTeams')}
      </div>
    );
  }
  return (
    <ul className="border-t border-surface-border bg-surface">
      {teams.map((team) => {
        const usersInTeam = usersByTeam.get(team.id) ?? [];
        const tl = usersInTeam.find((u) => isTeamLeaderRole(rolesById.get(u.roleId)));
        return (
          <li key={team.id} className="border-b border-surface-border last:border-b-0">
            <div className="flex items-center gap-3 p-3 ps-16">
              <Users2 className="h-4 w-4 text-ink-tertiary" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium text-ink-primary">{team.name}</span>
                {tl ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-ink-secondary">
                    <Crown className="h-3 w-3 text-status-info" aria-hidden="true" />
                    {tl.name}
                  </span>
                ) : (
                  <span className="text-[11px] text-status-warning">{t('issues.noTl')}</span>
                )}
              </div>
              <Badge tone="neutral">{t('tree.usersCount', { n: usersInTeam.length })}</Badge>
              {usersInTeam.length === 0 ? (
                <Badge tone="warning">{t('issues.noUsers')}</Badge>
              ) : null}
              {canWriteTeam ? (
                <Link
                  href={`/admin/teams`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  {t('tree.edit')}
                  <ArrowRight className="h-3 w-3" aria-hidden="true" />
                </Link>
              ) : (
                <span className="text-[11px] text-ink-tertiary">{t('tree.readOnly')}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PeopleFilterTab({
  active,
  onClick,
  label,
  tone = 'neutral',
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tone?: 'warning' | 'neutral';
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'rounded px-2.5 py-1 font-medium transition-colors',
        active
          ? 'bg-brand-50 text-brand-700'
          : tone === 'warning'
            ? 'text-status-warning hover:bg-status-warning/5'
            : 'text-ink-secondary hover:bg-surface',
      )}
    >
      {label}
    </button>
  );
}

function PeopleTable({
  users,
  teams,
  rolesById,
  filter,
  canEdit,
  scopeAssignments,
  scopeUnavailable,
  presenceByUser,
  presenceUnavailable,
  t,
}: {
  users: readonly AdminUser[];
  teams: readonly Team[];
  rolesById: Map<string, RoleSummary>;
  filter: 'all' | 'noTeam' | 'noRole';
  canEdit: boolean;
  scopeAssignments: ReadonlyMap<string, UserScopeAssignmentsForUser>;
  scopeUnavailable: boolean;
  presenceByUser: ReadonlyMap<string, OtherPresenceRow>;
  presenceUnavailable: boolean;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  if (!hasCapability('users.read')) {
    return (
      <Notice tone="info">
        <p className="text-sm font-medium">{t('people.noAccess.title')}</p>
        <p className="mt-1 text-xs text-ink-secondary">{t('people.noAccess.body')}</p>
      </Notice>
    );
  }
  const filtered =
    filter === 'noTeam'
      ? users.filter((u) => !u.teamId)
      : filter === 'noRole'
        ? users.filter((u) => !u.roleId)
        : users;
  if (users.length === 0) {
    return (
      <Notice tone="info">
        <p className="text-sm font-medium">{t('people.empty')}</p>
      </Notice>
    );
  }
  if (filtered.length === 0) {
    return (
      <Notice tone="success">
        <p className="text-sm font-medium">
          {filter === 'noTeam' ? t('people.allHaveTeam') : t('people.allHaveRole')}
        </p>
      </Notice>
    );
  }
  const teamsById = new Map<string, Team>(teams.map((tm) => [tm.id, tm]));
  return (
    <section className="overflow-hidden rounded-lg border border-surface-border bg-surface-card shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-surface-border bg-surface text-xs uppercase tracking-wide text-ink-tertiary">
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.user')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.presence')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.role')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.team')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.scope')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.status')}</th>
              <th className="px-4 py-3 text-start font-semibold">{t('people.columns.issues')}</th>
              <th className="px-4 py-3 text-end font-semibold">{t('people.columns.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const role = rolesById.get(u.roleId);
              const team = u.teamId ? teamsById.get(u.teamId) : null;
              const issues: string[] = [];
              if (!u.teamId) issues.push(t('people.issueChips.noTeam'));
              if (!u.roleId) issues.push(t('people.issueChips.noRole'));
              return (
                <tr
                  key={u.id}
                  className="border-b border-surface-border last:border-b-0 hover:bg-surface"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[11px] font-semibold text-brand-700"
                      >
                        {u.name
                          .split(/\s+/u)
                          .map((p) => p.charAt(0).toUpperCase())
                          .slice(0, 2)
                          .join('')}
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate font-medium text-ink-primary">{u.name}</span>
                        <span className="truncate text-[11px] text-ink-tertiary">{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-xs">
                    <PresenceChip
                      presence={presenceByUser.get(u.id)}
                      unavailable={presenceUnavailable}
                      t={t}
                    />
                  </td>
                  <td className="px-4 py-3 align-top text-ink-primary">
                    {role ? (
                      <Badge tone={isTeamLeaderRole(role) ? 'info' : 'neutral'}>
                        {role.nameEn}
                      </Badge>
                    ) : (
                      <span className="text-status-warning">{t('people.issueChips.noRole')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-ink-secondary">
                    {team ? (
                      team.name
                    ) : (
                      <span className="text-status-warning">{t('people.issueChips.noTeam')}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-xs">
                    <ScopeChip
                      assignments={scopeAssignments.get(u.id)}
                      unavailable={scopeUnavailable}
                      t={t}
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge
                      tone={
                        u.status === 'active'
                          ? 'healthy'
                          : u.status === 'disabled'
                            ? 'breach'
                            : 'neutral'
                      }
                    >
                      {u.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 align-top text-xs">
                    {issues.length === 0 ? (
                      <span className="text-ink-tertiary">—</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {issues.map((iss) => (
                          <li key={iss}>
                            <Badge tone="warning">{iss}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top text-end">
                    {canEdit ? (
                      <Link
                        href={`/admin/users`}
                        className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                      >
                        {t('people.edit')}
                        <ArrowRight className="h-3 w-3" aria-hidden="true" />
                      </Link>
                    ) : (
                      <span className="text-[11px] text-ink-tertiary">{t('people.readOnly')}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ScopeChip({
  assignments,
  unavailable,
  t,
}: {
  assignments: UserScopeAssignmentsForUser | undefined;
  unavailable: boolean;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  if (unavailable) {
    return <span className="text-ink-tertiary">{t('people.scopeUnavailable')}</span>;
  }
  if (!assignments) {
    return <span className="text-status-warning">{t('people.scopeNone')}</span>;
  }
  const companyCount = assignments.companies.length;
  const countryCount = assignments.countries.length;
  if (companyCount === 0 && countryCount === 0) {
    return <Badge tone="warning">{t('people.scopeNone')}</Badge>;
  }
  const parts: string[] = [];
  if (companyCount > 0) parts.push(t('people.scopeCompanyCount', { n: companyCount }));
  if (countryCount > 0) parts.push(t('people.scopeCountryCount', { n: countryCount }));
  return (
    <Badge tone="info" aria-label={parts.join(', ')}>
      {parts.join(' · ')}
    </Badge>
  );
}

/**
 * Sprint 10 (D10) — presence chip used by the People table.
 * Tone palette matches the rest of the admin surface; neutral
 * = unknown/offline.
 */
function PresenceChip({
  presence,
  unavailable,
  t,
}: {
  presence: OtherPresenceRow | undefined;
  unavailable: boolean;
  t: ReturnType<typeof useTranslations>;
}): JSX.Element {
  if (unavailable) {
    return <span className="text-ink-tertiary">{t('people.presence.unavailable')}</span>;
  }
  const status = presence?.status ?? 'offline';
  const tone: Record<typeof status, 'healthy' | 'warning' | 'info' | 'neutral'> = {
    online: 'healthy',
    away: 'warning',
    busy: 'info',
    offline: 'neutral',
  };
  return (
    <Badge tone={tone[status]}>{t(`people.presence.${status}` as 'people.presence.online')}</Badge>
  );
}

function AdvancedLink({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: typeof Building2;
}): JSX.Element {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-2 rounded-lg border border-surface-border bg-surface-card p-3 text-sm transition-colors hover:border-brand-200 hover:bg-brand-50"
      >
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-brand-50 text-brand-700">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="text-ink-primary">{label}</span>
        <ArrowRight className="ms-auto h-4 w-4 text-ink-tertiary" aria-hidden="true" />
      </Link>
    </li>
  );
}
