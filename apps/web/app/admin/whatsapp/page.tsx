'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Link as LinkIcon, MessagesSquare, Phone } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, conversationsApi, leadsApi } from '@/lib/api';
import type { Lead, WhatsAppConversation, WhatsAppMessage } from '@/lib/api-types';
import { cn } from '@/lib/utils';

/**
 * /admin/whatsapp (C34) — admin WhatsApp inbox.
 *
 * Read-only conversations + thread + manual "link to lead" action.
 * Reuses existing endpoints (/conversations, /:id/messages,
 * /:id/link-lead from C25). Sending messages is intentionally out of
 * scope here — that's the agent inbox at /agent/inbox.
 */

export default function AdminWhatsAppPage(): JSX.Element {
  const t = useTranslations('admin.whatsapp');
  const tCommon = useTranslations('admin.common');

  const [rows, setRows] = useState<WhatsAppConversation[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [chatLoading, setChatLoading] = useState<boolean>(false);

  const [linkOpen, setLinkOpen] = useState<boolean>(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [linkLeadId, setLinkLeadId] = useState<string>('');
  const [linking, setLinking] = useState<boolean>(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await conversationsApi.list({ limit: 100 });
      setRows(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    setChatLoading(true);
    let cancelled = false;
    conversationsApi
      .listMessages(selectedId, { limit: 200 })
      .then((items) => {
        if (!cancelled) setMessages(items);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = useMemo(() => rows.find((c) => c.id === selectedId) ?? null, [rows, selectedId]);

  // The /conversations/:id endpoint already returns a `lead` inline (C25),
  // but the list endpoint does not — we surface it lazily via the
  // selected conversation's individual fetch. For now, we just show
  // whether the conversation has any leadId.
  const [selectedDetail, setSelectedDetail] = useState<
    (WhatsAppConversation & { lead?: { id: string; name: string; phone: string } | null }) | null
  >(null);

  useEffect(() => {
    if (!selectedId) {
      setSelectedDetail(null);
      return;
    }
    let cancelled = false;
    void conversationsApi
      .get(selectedId)
      .then((c) => {
        if (!cancelled) setSelectedDetail(c as never);
      })
      .catch(() => {
        // silent — list-row is enough for the header
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, notice]);

  async function openLinkModal(): Promise<void> {
    setLinkOpen(true);
    setLinkError(null);
    setLinkLeadId('');
    try {
      const page = await leadsApi.list({ limit: 200 });
      setLeads(page.items);
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onLink(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!selectedId || !linkLeadId) return;
    setLinking(true);
    setLinkError(null);
    try {
      await conversationsApi.linkLead(selectedId, linkLeadId);
      setNotice(t('linked'));
      setLinkOpen(false);
    } catch (err) {
      setLinkError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}

      <div className="grid min-h-[480px] gap-3 md:grid-cols-[320px_minmax(0,1fr)] md:gap-4">
        <section className="flex min-h-0 flex-col rounded-lg border border-surface-border bg-surface-card shadow-card">
          <header className="border-b border-surface-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-tertiary">
            {t('title')}
          </header>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <p className="p-6 text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
            ) : rows.length === 0 ? (
              <div className="p-3">
                <EmptyState
                  icon={<MessagesSquare className="h-7 w-7" aria-hidden="true" />}
                  title={tCommon('errorTitle')}
                  body={t('subtitle')}
                />
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {rows.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(c.id)}
                      className={cn(
                        'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-start transition-colors',
                        selectedId === c.id ? 'bg-brand-50' : 'hover:bg-brand-50/50',
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                        <Phone className="h-3 w-3 text-ink-tertiary" aria-hidden="true" />
                        <code className="font-mono">{c.phone}</code>
                      </span>
                      <p className="line-clamp-1 w-full text-xs text-ink-secondary">
                        {c.lastMessageText || '—'}
                      </p>
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-wide text-ink-tertiary">
                          {c.status}
                        </span>
                        <span className="text-[10px] text-ink-tertiary">
                          {new Date(c.lastMessageAt).toLocaleString()}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="flex min-h-0 flex-col rounded-lg border border-surface-border bg-surface-card shadow-card">
          {selected ? (
            <>
              <div className="flex items-center justify-between gap-2 border-b border-surface-border px-3 py-2">
                <div className="flex flex-col leading-tight">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
                    <Phone className="h-3.5 w-3.5 text-ink-tertiary" aria-hidden="true" />
                    <code className="font-mono">{selected.phone}</code>
                  </span>
                  <span className="text-[11px] text-ink-tertiary">
                    <Badge tone={selected.status === 'open' ? 'healthy' : 'inactive'}>
                      {selected.status}
                    </Badge>
                    <span className="ms-2">
                      {selectedDetail?.lead
                        ? `${selectedDetail.lead.name} · ${selectedDetail.lead.phone}`
                        : t('noLead')}
                    </span>
                  </span>
                </div>
                <Button variant="secondary" size="sm" onClick={() => void openLinkModal()}>
                  <LinkIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('linkLeadCta')}
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto bg-surface px-3 py-3">
                {chatLoading ? (
                  <p className="text-center text-sm text-ink-secondary">{tCommon('loading')}</p>
                ) : messages.length === 0 ? (
                  <p className="text-center text-sm text-ink-tertiary">{t('noMessages')}</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {messages.map((m) => {
                      const out = m.direction === 'outbound';
                      return (
                        <li
                          key={m.id}
                          className={cn('flex', out ? 'justify-end' : 'justify-start')}
                        >
                          <div
                            className={cn(
                              'max-w-[85%] rounded-lg px-3 py-2 text-sm shadow-sm sm:max-w-[70%]',
                              out
                                ? 'bg-brand-600 text-white'
                                : 'border border-surface-border bg-surface-card text-ink-primary',
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words">{m.text}</p>
                            <p
                              className={cn(
                                'mt-1 text-end text-[11px]',
                                out ? 'text-white/70' : 'text-ink-tertiary',
                              )}
                            >
                              {new Date(m.createdAt).toLocaleString()}
                            </p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<MessagesSquare className="h-8 w-8" aria-hidden="true" />}
                title={t('selectAConversation')}
                body={t('selectAConversationHint')}
              />
            </div>
          )}
        </section>
      </div>

      <Modal open={linkOpen} title={t('linkLeadTitle')} onClose={() => setLinkOpen(false)}>
        <form onSubmit={onLink} className="flex flex-col gap-3">
          {linkError ? <Notice tone="error">{linkError}</Notice> : null}
          <p className="text-sm text-ink-secondary">{t('linkLeadHint')}</p>
          <Field label={t('linkLeadCta')} required>
            <Select value={linkLeadId} onChange={(e) => setLinkLeadId(e.target.value)} required>
              <option value="" disabled>
                {tCommon('select')}
              </option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} — {l.phone}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" type="button" onClick={() => setLinkOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" loading={linking} disabled={!linkLeadId}>
              {tCommon('save')}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
