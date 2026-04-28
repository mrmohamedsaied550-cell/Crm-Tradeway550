import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Building2, Globe, Users2, UserCog, Contact, ArrowUpRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';

interface CardDef {
  href: string;
  titleKey: 'companies' | 'countries' | 'teams' | 'users' | 'leads';
  descKey: 'companiesDesc' | 'countriesDesc' | 'teamsDesc' | 'usersDesc' | 'leadsDesc';
  ctaKey: 'openCompanies' | 'openCountries' | 'openTeams' | 'openUsers' | 'openLeads';
  icon: typeof Building2;
}

const CARDS: readonly CardDef[] = [
  {
    href: '/admin/companies',
    titleKey: 'companies',
    descKey: 'companiesDesc',
    ctaKey: 'openCompanies',
    icon: Building2,
  },
  {
    href: '/admin/countries',
    titleKey: 'countries',
    descKey: 'countriesDesc',
    ctaKey: 'openCountries',
    icon: Globe,
  },
  {
    href: '/admin/teams',
    titleKey: 'teams',
    descKey: 'teamsDesc',
    ctaKey: 'openTeams',
    icon: Users2,
  },
  {
    href: '/admin/users',
    titleKey: 'users',
    descKey: 'usersDesc',
    ctaKey: 'openUsers',
    icon: UserCog,
  },
  {
    href: '/admin/leads',
    titleKey: 'leads',
    descKey: 'leadsDesc',
    ctaKey: 'openLeads',
    icon: Contact,
  },
];

/**
 * Admin landing page (C13).
 *
 * Plain server component — only renders quick-link cards into the screens
 * that come next. No data fetching here so there's no flash before the
 * auth bar resolves the current session.
 */
export default function AdminPage() {
  const tAdmin = useTranslations('admin');
  const tDashboard = useTranslations('admin.dashboard');
  const tNav = useTranslations('admin.sideNav');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={tAdmin('title')} subtitle={tAdmin('subtitle')} />

      <section className="rounded-lg border border-surface-border bg-surface-card p-6 shadow-card">
        <h2 className="text-base font-semibold text-ink-primary">{tDashboard('heading')}</h2>
        <p className="mt-1 text-sm text-ink-secondary">{tDashboard('body')}</p>

        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <li key={card.href}>
                <Link
                  href={card.href}
                  className="group flex h-full flex-col gap-3 rounded-lg border border-surface-border bg-surface p-4 transition-colors hover:border-brand-200 hover:bg-brand-50"
                >
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-brand-600/10 text-brand-700">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="text-sm font-semibold text-ink-primary">
                      {tNav(card.titleKey)}
                    </span>
                  </div>
                  <p className="text-xs text-ink-secondary">{tDashboard(card.descKey)}</p>
                  <span className="mt-auto inline-flex items-center gap-1 text-xs font-medium text-brand-700 group-hover:text-brand-800">
                    {tDashboard(card.ctaKey)}
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
