'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Facebook, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { ApiError, metaAdminApi, metaLeadSourcesApi } from '@/lib/api';
import type {
  MetaFieldMappingV2,
  MetaGraphForm,
  MetaGraphPage,
  MetaLeadSource,
  MetaOAuthConnectionSummary,
} from '@/lib/api-types';

import { FieldMappingUI } from './field-mapping-ui';

/**
 * Sprint M2 / Phase 3 — guided wizard for creating a new Meta Lead
 * Ads source. Replaces the raw-JSON form behind a five-step cascade:
 *
 *   1. Connect with Facebook (OAuth popup, captures connectionId
 *      via postMessage from the popup landing page).
 *   2. Project    (static list per CRM business line).
 *   3. Channel    (static list — Facebook / Instagram).
 *   4. Campaign   (free-text operator label; distinct from Meta's
 *                  runtime campaign_id which the webhook captures).
 *   5. Page       (fetched via /meta/pages once connected).
 *   6. Form       (fetched via /meta/forms once a Page is picked).
 *   7. Field mapping (FieldMappingUI; rendered once a Form is picked).
 *
 * Save POSTs a fully populated `CreateMetaLeadSourceInput` — including
 * the OAuth wiring (`oauthConnectionId`, `pageName`, `formName`), the
 * operator taxonomy (`project`, `channel`, `campaign`), and a V2
 * field mapping. The verify_token field on the row is auto-generated
 * (the OAuth-driven path doesn't expose a webhook handshake URL to
 * the operator); `app_secret` is left null so signature verification
 * falls back to the `META_APP_SECRET` env (Phase 2 behaviour).
 */
export interface NewFacebookIntegrationModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (source: MetaLeadSource) => void;
}

// Static lists per the prompt. Operator can request additions in
// follow-up sprints; backing both in the schema as free strings keeps
// us from needing a migration when this list grows.
const PROJECT_OPTIONS = ['Uber Scooter', 'inDrive', 'DiDi'] as const;
const CHANNEL_OPTIONS = ['Facebook', 'Instagram'] as const;

type Stage =
  | 'needs_connection'
  | 'picking_taxonomy'
  | 'picking_page'
  | 'picking_form'
  | 'mapping'
  | 'saving';

function isUuid(s: string | null): s is string {
  if (typeof s !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function NewFacebookIntegrationModal({
  open,
  onClose,
  onCreated,
}: NewFacebookIntegrationModalProps): JSX.Element {
  const t = useTranslations('admin.metaIntegration');
  const tCommon = useTranslations('admin.common');
  const { toast } = useToast();

  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [connectionName, setConnectionName] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<boolean>(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [project, setProject] = useState<string>('');
  const [channel, setChannel] = useState<string>('');
  const [campaign, setCampaign] = useState<string>('');

  const [pages, setPages] = useState<MetaGraphPage[] | null>(null);
  const [pagesLoading, setPagesLoading] = useState<boolean>(false);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string>('');

  const [forms, setForms] = useState<MetaGraphForm[] | null>(null);
  const [formsLoading, setFormsLoading] = useState<boolean>(false);
  const [formsError, setFormsError] = useState<string | null>(null);
  const [formId, setFormId] = useState<string>('');

  const [mapping, setMapping] = useState<MetaFieldMappingV2 | null>(null);
  const [mappingValid, setMappingValid] = useState<boolean>(false);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset everything when the modal closes so a re-open starts clean.
  useEffect(() => {
    if (open) return;
    setConnectionId(null);
    setConnectionName(null);
    setConnectError(null);
    setProject('');
    setChannel('');
    setCampaign('');
    setPages(null);
    setPagesError(null);
    setPageId('');
    setForms(null);
    setFormsError(null);
    setFormId('');
    setMapping(null);
    setMappingValid(false);
    setSubmitError(null);
  }, [open]);

  // On open: preload the tenant's existing OAuth connections so an
  // already-connected operator doesn't have to re-authorise just to
  // add a second source.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    metaAdminApi
      .listConnections()
      .then((rows: MetaOAuthConnectionSummary[]) => {
        if (cancelled) return;
        const active = rows.find((r) => r.revokedAt === null);
        if (active) {
          setConnectionId(active.id);
          setConnectionName(active.facebookName);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConnectError(err instanceof ApiError ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // postMessage listener for the OAuth popup's "complete" signal.
  // The popup posts `{ type: 'meta-oauth-complete', connectionId }`
  // from the same origin; we ignore everything else.
  useEffect(() => {
    if (!open) return;
    function onMessage(ev: MessageEvent): void {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; connectionId?: string } | null;
      if (!data || data.type !== 'meta-oauth-complete') return;
      if (typeof data.connectionId !== 'string' || !isUuid(data.connectionId)) return;
      setConnectionId(data.connectionId);
      setConnecting(false);
      // Refresh the connection summary so we can display the
      // facebookName the popup just upserted.
      void metaAdminApi.listConnections().then((rows: MetaOAuthConnectionSummary[]) => {
        const match = rows.find((r) => r.id === data.connectionId);
        if (match) setConnectionName(match.facebookName);
      });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [open]);

  // Cascade: fetch pages when a connection is picked.
  useEffect(() => {
    if (!connectionId) {
      setPages(null);
      return;
    }
    let cancelled = false;
    setPagesLoading(true);
    setPagesError(null);
    metaAdminApi
      .getPages(connectionId)
      .then((rows) => {
        if (cancelled) return;
        setPages(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPagesError(err instanceof ApiError ? err.message : String(err));
        setPages(null);
      })
      .finally(() => {
        if (cancelled) return;
        setPagesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // Cascade: fetch forms when a page is picked. Reset form selection
  // + mapping when the page changes so stale state doesn't carry.
  useEffect(() => {
    if (!connectionId || !pageId) {
      setForms(null);
      setFormId('');
      setMapping(null);
      return;
    }
    let cancelled = false;
    setFormsLoading(true);
    setFormsError(null);
    setFormId('');
    setMapping(null);
    metaAdminApi
      .getForms(connectionId, pageId)
      .then((rows) => {
        if (cancelled) return;
        setForms(rows);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFormsError(err instanceof ApiError ? err.message : String(err));
        setForms(null);
      })
      .finally(() => {
        if (cancelled) return;
        setFormsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, pageId]);

  const stage: Stage = useMemo(() => {
    if (submitting) return 'saving';
    if (!connectionId) return 'needs_connection';
    if (!project || !channel || !campaign.trim()) return 'picking_taxonomy';
    if (!pageId) return 'picking_page';
    if (!formId) return 'picking_form';
    return 'mapping';
  }, [submitting, connectionId, project, channel, campaign, pageId, formId]);

  const canSave = stage === 'mapping' && mappingValid && !!mapping;

  const startOAuth = useCallback(async (): Promise<void> => {
    setConnecting(true);
    setConnectError(null);
    try {
      const returnTo = `${window.location.origin}/admin/meta-lead-sources/oauth-callback`;
      const { authorizeUrl } = await metaAdminApi.getAuthorizeUrl(returnTo);
      const popup = window.open(
        authorizeUrl,
        'meta-oauth',
        'width=720,height=820,menubar=no,toolbar=no,status=no',
      );
      if (!popup) {
        setConnectError(t('errors.popupBlocked'));
        setConnecting(false);
        return;
      }
      // Defensive poll: if the operator closes the popup before
      // OAuth completes, clear the spinner. The postMessage path is
      // the happy case; this is the cancellation backstop.
      const timer = window.setInterval(() => {
        if (popup.closed) {
          window.clearInterval(timer);
          setConnecting((prev) => (prev ? false : prev));
        }
      }, 500);
    } catch (err) {
      setConnectError(err instanceof ApiError ? err.message : String(err));
      setConnecting(false);
    }
  }, [t]);

  function findPage(id: string): MetaGraphPage | undefined {
    return pages?.find((p) => p.id === id);
  }

  function findForm(id: string): MetaGraphForm | undefined {
    return forms?.find((f) => f.id === id);
  }

  async function onSave(): Promise<void> {
    if (!connectionId || !pageId || !formId || !mapping || !mappingValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const page = findPage(pageId);
      const form = findForm(formId);
      const verifyToken =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().replace(/-/g, '')
          : Math.random().toString(36).slice(2) + Date.now().toString(36);
      const displayName = form?.name ?? page?.name ?? `${project} — ${campaign}`;
      const created = await metaLeadSourcesApi.create({
        displayName,
        pageId,
        formId,
        verifyToken,
        defaultSource: 'meta',
        fieldMapping: mapping,
        isActive: true,
        oauthConnectionId: connectionId,
        pageName: page?.name ?? null,
        formName: form?.name ?? null,
        project,
        channel,
        campaign: campaign.trim(),
      });
      toast({ tone: 'success', title: t('created') });
      onCreated(created);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const isConnected = connectionId !== null;
  const channelDisabled = !project;
  const campaignDisabled = !channel;
  const pageDisabled = !campaign.trim();
  const formDisabled = !pageId || pages === null;
  const mappingVisible = stage === 'mapping' || stage === 'saving';

  return (
    <Modal
      open={open}
      title={t('newTitle')}
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button onClick={() => void onSave()} disabled={!canSave} loading={submitting}>
            {tCommon('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* — Step 1: Connect with Facebook — */}
        <section className="rounded-lg border border-surface-border bg-surface p-4">
          <header className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink-primary">{t('steps.connect')}</h3>
            {isConnected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-healthy/10 px-2 py-0.5 text-[11px] font-medium text-status-healthy">
                {t('connectedAs', { name: connectionName ?? '—' })}
              </span>
            ) : null}
          </header>
          {connectError ? <Notice tone="error">{connectError}</Notice> : null}
          {!isConnected ? (
            <Button onClick={() => void startOAuth()} loading={connecting} variant="primary">
              <Facebook className="h-4 w-4" aria-hidden="true" />
              {t('connectButton')}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void startOAuth()}
              loading={connecting}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('reconnectButton')}
            </Button>
          )}
        </section>

        {/* — Cascading dropdowns — */}
        <div className="flex flex-col gap-3">
          <Field label={t('fields.project')} required>
            <Select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setChannel('');
                setCampaign('');
                setPageId('');
                setFormId('');
              }}
              disabled={!isConnected}
            >
              <option value="">{t('placeholders.project')}</option>
              {PROJECT_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.channel')} required>
            <Select
              value={channel}
              onChange={(e) => {
                setChannel(e.target.value);
                setCampaign('');
                setPageId('');
                setFormId('');
              }}
              disabled={channelDisabled}
            >
              <option value="">{t('placeholders.channel')}</option>
              {CHANNEL_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('fields.campaign')} required hint={t('fields.campaignHint')}>
            <Input
              value={campaign}
              onChange={(e) => {
                setCampaign(e.target.value);
                setPageId('');
                setFormId('');
              }}
              disabled={campaignDisabled}
              maxLength={255}
              placeholder={t('placeholders.campaign')}
            />
          </Field>

          <Field label={t('fields.page')} required>
            <Select
              value={pageId}
              onChange={(e) => setPageId(e.target.value)}
              disabled={pageDisabled || pagesLoading}
            >
              <option value="">
                {pagesLoading ? t('placeholders.loadingPages') : t('placeholders.page')}
              </option>
              {(pages ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {pagesError ? <p className="mt-1 text-xs text-status-breach">{pagesError}</p> : null}
          </Field>

          <Field label={t('fields.form')} required>
            <Select
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              disabled={formDisabled || formsLoading}
            >
              <option value="">
                {formsLoading ? t('placeholders.loadingForms') : t('placeholders.form')}
              </option>
              {(forms ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {f.status && f.status !== 'ACTIVE' ? ` · ${f.status.toLowerCase()}` : ''}
                </option>
              ))}
            </Select>
            {formsError ? <p className="mt-1 text-xs text-status-breach">{formsError}</p> : null}
          </Field>
        </div>

        {/* — Step 7: Field mapping — */}
        {mappingVisible && connectionId && formId ? (
          <section className="rounded-lg border border-surface-border bg-surface-card p-4">
            <header className="mb-3 flex items-center gap-2">
              <h3 className="text-sm font-semibold text-ink-primary">{t('steps.mapping')}</h3>
              <span className="text-xs text-ink-tertiary">{t('mapping.subtitle')}</span>
            </header>
            <FieldMappingUI
              connectionId={connectionId}
              formId={formId}
              onMappingChange={(m, valid) => {
                setMapping(m);
                setMappingValid(valid);
              }}
            />
          </section>
        ) : (
          <Notice tone="info">{t('hints.completeStepsAbove')}</Notice>
        )}

        {submitError ? <Notice tone="error">{submitError}</Notice> : null}
      </div>
    </Modal>
  );
}
