'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Users, Building2, MapPin, ShieldOff, AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { MultiSelectChips, type MultiSelectOption } from '@/components/ui/multi-select-chips';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, companiesApi, countriesApi, rolesApi, usersApi } from '@/lib/api';
import type {
  AdminUser,
  Company,
  Country,
  RoleDetail,
  RoleScopeRow,
  UserScopeAssignments,
} from '@/lib/api-types';

/**
 * Phase C — C9: scope-assignment modal.
 *
 * Opened from the per-row "Scope" action on the users admin page. The
 * modal fetches the user's role to discover which resources are scoped
 * to `company` / `country` and only renders selectors for the
 * dimensions that are actually consumed.
 *
 * Heuristics for "do we need a selector at all":
 *   - role.scopes contains a row with scope='company' on any resource
 *     → render the Companies multi-select.
 *   - role.scopes contains a row with scope='country' on any resource
 *     → render the Countries multi-select.
 *   - Neither → render an explanatory notice, no inputs.
 *
 * Validation rule mirrors the resolver in
 * `scope-context.service.ts`: a user with company / country scope but
 * zero assignments sees nothing. The Save button surfaces this as a
 * blocking warning so the admin can't accidentally lock a user out.
 */

interface Props {
  user: AdminUser;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

const SCOPE_ICONS = {
  global: Globe,
  country: MapPin,
  company: Building2,
  team: Users,
  own: ShieldOff,
} as const;

export function UserScopeModal({ user, open, onClose, onSaved }: Props): JSX.Element {
  const t = useTranslations('admin.userScope');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<RoleDetail | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [assignments, setAssignments] = useState<UserScopeAssignments | null>(null);

  const [selectedCompanyIds, setSelectedCompanyIds] = useState<string[]>([]);
  const [selectedCountryIds, setSelectedCountryIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset state every time the modal opens for a different user.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSubmitError(null);

    Promise.all([
      rolesApi.get(user.roleId),
      companiesApi.list(),
      countriesApi.list(),
      usersApi.listScopeAssignments(user.id),
    ])
      .then(([r, cos, ctys, asg]) => {
        if (cancelled) return;
        setRole(r);
        setCompanies(cos);
        setCountries(ctys);
        setAssignments(asg);
        setSelectedCompanyIds(asg.companies.map((c) => c.id));
        setSelectedCountryIds(asg.countries.map((c) => c.id));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, user.id, user.roleId]);

  /** The set of distinct scope values the role uses across all resources. */
  const scopeValues = useMemo<ReadonlySet<RoleScopeRow['scope']>>(() => {
    if (!role) return new Set();
    return new Set(role.scopes.map((s) => s.scope));
  }, [role]);

  const needsCompany = scopeValues.has('company');
  const needsCountry = scopeValues.has('country');
  const needsAnything = needsCompany || needsCountry;

  // Validation: a scope that requires assignments must have at least one.
  const missingCompany = needsCompany && selectedCompanyIds.length === 0;
  const missingCountry = needsCountry && selectedCountryIds.length === 0;
  const blocked = missingCompany || missingCountry;

  // Lookup helpers for the preview block.
  const companyById = useMemo(() => new Map(companies.map((c) => [c.id, c])), [companies]);
  const countryById = useMemo(() => new Map(countries.map((c) => [c.id, c])), [countries]);

  const companyOptions: MultiSelectOption[] = useMemo(
    () =>
      companies
        .filter((c) => c.isActive)
        .map((c) => ({ value: c.id, label: c.name, secondary: c.code })),
    [companies],
  );
  const countryOptions: MultiSelectOption[] = useMemo(
    () =>
      countries
        .filter((c) => c.isActive)
        .map((c) => {
          const co = companyById.get(c.companyId);
          return {
            value: c.id,
            label: c.name,
            secondary: co ? `${c.code} · ${co.name}` : c.code,
          };
        }),
    [countries, companyById],
  );

  async function onSave(): Promise<void> {
    if (blocked) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const next = await usersApi.putScopeAssignments(user.id, {
        companyIds: needsCompany ? selectedCompanyIds : [],
        countryIds: needsCountry ? selectedCountryIds : [],
      });
      setAssignments(next);
      toast({ tone: 'success', title: t('saved') });
      onSaved?.();
      onClose();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('title', { name: user.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          {needsAnything ? (
            <Button onClick={() => void onSave()} loading={submitting} disabled={blocked}>
              {tCommon('save')}
            </Button>
          ) : null}
        </>
      }
    >
      {loading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
      ) : error ? (
        <Notice tone="error">{error}</Notice>
      ) : !role || !assignments ? null : (
        <div className="flex flex-col gap-4">
          {/* Role context — short, scannable. */}
          <RoleSummaryBlock role={role} />

          {/* No-input case: role doesn't need assignments. */}
          {!needsAnything ? (
            <Notice tone="info">{t('notNeeded', { role: role.nameEn })}</Notice>
          ) : (
            <>
              {submitError ? <Notice tone="error">{submitError}</Notice> : null}

              {needsCompany ? (
                <section className="flex flex-col gap-1.5">
                  <header className="flex items-center justify-between">
                    <label className="text-sm font-medium text-ink-primary">
                      {t('companies.label')}
                    </label>
                    <span className="text-xs text-ink-tertiary">
                      {t('companies.count', { n: selectedCompanyIds.length })}
                    </span>
                  </header>
                  <p className="text-xs text-ink-tertiary">{t('companies.help')}</p>
                  <MultiSelectChips
                    options={companyOptions}
                    value={selectedCompanyIds}
                    onChange={setSelectedCompanyIds}
                    placeholder={t('companies.placeholder')}
                    emptyText={t('companies.empty')}
                  />
                  {missingCompany ? (
                    <p className="text-xs text-status-warning">{t('companies.required')}</p>
                  ) : null}
                </section>
              ) : null}

              {needsCountry ? (
                <section className="flex flex-col gap-1.5">
                  <header className="flex items-center justify-between">
                    <label className="text-sm font-medium text-ink-primary">
                      {t('countries.label')}
                    </label>
                    <span className="text-xs text-ink-tertiary">
                      {t('countries.count', { n: selectedCountryIds.length })}
                    </span>
                  </header>
                  <p className="text-xs text-ink-tertiary">{t('countries.help')}</p>
                  <MultiSelectChips
                    options={countryOptions}
                    value={selectedCountryIds}
                    onChange={setSelectedCountryIds}
                    placeholder={t('countries.placeholder')}
                    emptyText={t('countries.empty')}
                  />
                  {missingCountry ? (
                    <p className="text-xs text-status-warning">{t('countries.required')}</p>
                  ) : null}
                </section>
              ) : null}

              {/* Live preview — what will this user actually see? */}
              <PreviewBlock
                role={role}
                companies={selectedCompanyIds
                  .map((id) => companyById.get(id))
                  .filter((c): c is Company => c !== undefined)}
                countries={selectedCountryIds
                  .map((id) => countryById.get(id))
                  .filter((c): c is Country => c !== undefined)}
                missingCompany={missingCompany}
                missingCountry={missingCountry}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/**
 * Compact role badge: name + the scope value per resource. Shown only
 * for the resources whose scope is something other than the default
 * (`global`) so the admin sees what's actually relevant.
 */
function RoleSummaryBlock({ role }: { role: RoleDetail }): JSX.Element {
  const t = useTranslations('admin.userScope');

  // Distinct scope values the role uses, with a one-line explanation.
  const distinct = useMemo(() => {
    const seen = new Set<RoleScopeRow['scope']>();
    for (const s of role.scopes) seen.add(s.scope);
    return Array.from(seen);
  }, [role]);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-surface-border bg-surface px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-ink-tertiary">
        {t('roleHeader', { name: role.nameEn })}
      </div>
      <ul className="flex flex-col gap-1">
        {distinct.map((s) => {
          const Icon = SCOPE_ICONS[s];
          return (
            <li key={s} className="flex items-start gap-2 text-xs text-ink-secondary">
              <Icon className="mt-0.5 h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
              <span>
                <span className="font-medium text-ink-primary">
                  {t(`scopeNames.${s}` as 'scopeNames.global')}
                </span>
                {' — '}
                {t(`scopeExplanations.${s}` as 'scopeExplanations.global')}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "What this user will see" preview. Renders a tight summary block so
 * the admin can confirm intent before saving.
 */
function PreviewBlock({
  companies,
  countries,
  missingCompany,
  missingCountry,
}: {
  role: RoleDetail;
  companies: Company[];
  countries: Country[];
  missingCompany: boolean;
  missingCountry: boolean;
}): JSX.Element {
  const t = useTranslations('admin.userScope');

  // No-data state — the user will see nothing because of missing
  // assignments. Mirror the C3 resolver behaviour explicitly so the
  // admin understands why.
  if (missingCompany || missingCountry) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 px-3 py-2 text-status-warning"
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="flex flex-col">
          <strong className="text-sm">{t('preview.blockedTitle')}</strong>
          <span className="text-xs">{t('preview.blockedBody')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-status-info/40 bg-status-info/5 px-3 py-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-status-info">
        {t('preview.title')}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-ink-secondary">
        {companies.length > 0 ? (
          <li>
            {t('preview.companies', { n: companies.length })}
            {': '}
            <span className="text-ink-primary">{companies.map((c) => c.name).join(', ')}</span>
          </li>
        ) : null}
        {countries.length > 0 ? (
          <li>
            {t('preview.countries', { n: countries.length })}
            {': '}
            <span className="text-ink-primary">{countries.map((c) => c.name).join(', ')}</span>
          </li>
        ) : null}
        {companies.length === 0 && countries.length === 0 ? (
          <li className="text-ink-tertiary">{t('preview.empty')}</li>
        ) : null}
      </ul>
    </div>
  );
}
