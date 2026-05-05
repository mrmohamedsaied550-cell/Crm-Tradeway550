'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/components/ui/toast';
import { PartnerSourceForm } from '@/components/admin/partner-sources/partner-source-form';
import { partnerSourcesApi } from '@/lib/api';
import type { CreatePartnerSourceInput } from '@/lib/api-types';
import { hasCapability } from '@/lib/auth';

/**
 * Phase D4 — D4.2: Create Partner Source page.
 *
 * Reuses the shared `<PartnerSourceForm>` in `mode='create'`.
 * Mappings are configured on the detail page after creation —
 * matches the natural flow (you can't map columns before the
 * source has an id and at least a basic config).
 */
export default function NewPartnerSourcePage(): JSX.Element {
  const t = useTranslations('admin.partnerSources');
  const tForm = useTranslations('admin.partnerSources.form');
  const { toast } = useToast();
  const router = useRouter();

  const canWrite = hasCapability('partner.source.write');

  if (!canWrite) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title={t('newTitle')} subtitle={t('newSubtitle')} />
        <Notice tone="error">{t('noAccessBody')}</Notice>
      </div>
    );
  }

  async function onSubmit(input: CreatePartnerSourceInput): Promise<void> {
    const created = await partnerSourcesApi.create(input);
    toast({ tone: 'success', title: tForm('createdToast') });
    router.push(`/admin/partner-sources/${created.id}`);
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={t('newTitle')}
        subtitle={t('newSubtitle')}
        actions={
          <Link href="/admin/partner-sources">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('backCta')}
            </Button>
          </Link>
        }
      />

      <PartnerSourceForm mode="create" onSubmit={onSubmit} />
    </div>
  );
}
