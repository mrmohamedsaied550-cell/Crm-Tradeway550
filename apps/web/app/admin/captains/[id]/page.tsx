'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { ApiError, captainDocumentsApi, captainTripsApi, captainsApi } from '@/lib/api';
import type {
  Captain,
  CaptainDocument,
  CaptainDocumentStatus,
  CaptainTripRow,
} from '@/lib/api-types';
import { cn } from '@/lib/utils';

type Tab = 'summary' | 'documents' | 'trips';

const DOC_KINDS = ['id_card', 'license', 'vehicle_registration', 'other'] as const;

function statusTone(s: CaptainDocumentStatus): 'healthy' | 'warning' | 'breach' | 'inactive' {
  if (s === 'approved') return 'healthy';
  if (s === 'rejected') return 'breach';
  if (s === 'expired') return 'inactive';
  return 'warning';
}

/**
 * P2-09 — captain detail page with three tabs:
 *   - summary: name / phone / team / onboarding flags / first trip /
 *     trip count (single-source-of-truth for the captain row).
 *   - documents: list + upload + approve/reject/delete.
 *   - trips: list + admin trip-ingest dialog.
 *
 * Capabilities:
 *   - read everywhere: `captain.read`
 *   - upload: `captain.document.write` (the page renders the button
 *     unconditionally; the API rejects with 403 when the user
 *     lacks the cap)
 *   - approve/reject: `captain.document.review`
 *   - record trip: `captain.trip.write`
 */
export default function CaptainDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const captainId = params.id;
  const t = useTranslations('admin.captains.detail');
  const tDocs = useTranslations('admin.captains.detail.documents');
  const tTrips = useTranslations('admin.captains.detail.trips');
  const tCaptains = useTranslations('admin.captains');
  const tCommon = useTranslations('admin.common');

  const [tab, setTab] = useState<Tab>('summary');
  const [captain, setCaptain] = useState<Captain | null>(null);
  const [documents, setDocuments] = useState<CaptainDocument[]>([]);
  const [trips, setTrips] = useState<CaptainTripRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reloadCaptain = useCallback(async (): Promise<void> => {
    try {
      const c = await captainsApi.get(captainId);
      setCaptain(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [captainId]);

  const reloadDocuments = useCallback(async (): Promise<void> => {
    try {
      const list = await captainDocumentsApi.listForCaptain(captainId);
      setDocuments(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [captainId]);

  const reloadTrips = useCallback(async (): Promise<void> => {
    try {
      const list = await captainTripsApi.listForCaptain(captainId);
      setTrips(list);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [captainId]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void Promise.all([reloadCaptain(), reloadDocuments(), reloadTrips()]).finally(() =>
      setLoading(false),
    );
  }, [reloadCaptain, reloadDocuments, reloadTrips]);

  // ─── upload modal ───
  const [uploadOpen, setUploadOpen] = useState<boolean>(false);
  const [uploadForm, setUploadForm] = useState<{
    kind: string;
    storageRef: string;
    fileName: string;
    mimeType: string;
    sizeBytes: string;
    expiresAt: string;
  }>({
    kind: 'id_card',
    storageRef: '',
    fileName: '',
    mimeType: 'application/pdf',
    sizeBytes: '0',
    expiresAt: '',
  });
  const [uploading, setUploading] = useState<boolean>(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);

  function openUpload(): void {
    setUploadForm({
      kind: 'id_card',
      storageRef: '',
      fileName: '',
      mimeType: 'application/pdf',
      sizeBytes: '0',
      expiresAt: '',
    });
    setUploadErr(null);
    setUploadOpen(true);
  }

  async function onUpload(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setUploading(true);
    setUploadErr(null);
    try {
      const sizeBytes = Number.parseInt(uploadForm.sizeBytes, 10) || 0;
      await captainDocumentsApi.upload(captainId, {
        kind: uploadForm.kind.trim(),
        storageRef: uploadForm.storageRef.trim(),
        fileName: uploadForm.fileName.trim(),
        mimeType: uploadForm.mimeType.trim(),
        sizeBytes,
        expiresAt: uploadForm.expiresAt ? new Date(uploadForm.expiresAt).toISOString() : null,
      });
      setUploadOpen(false);
      setNotice(tCommon('created'));
      await reloadDocuments();
    } catch (err) {
      setUploadErr(err instanceof ApiError ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  async function onReview(doc: CaptainDocument, decision: 'approve' | 'reject'): Promise<void> {
    const notes = decision === 'reject' ? (window.prompt(tDocs('notesLabel')) ?? '') : '';
    try {
      await captainDocumentsApi.review(doc.id, {
        decision,
        ...(notes && { notes }),
      });
      setNotice(tCommon('saved'));
      await Promise.all([reloadDocuments(), reloadCaptain()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function onDeleteDoc(doc: CaptainDocument): Promise<void> {
    if (!window.confirm(tDocs('deleteConfirm'))) return;
    try {
      await captainDocumentsApi.remove(doc.id);
      setNotice(tCommon('saved'));
      await reloadDocuments();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }

  // ─── trip-record modal ───
  const [tripOpen, setTripOpen] = useState<boolean>(false);
  const [tripForm, setTripForm] = useState<{ tripId: string; occurredAt: string }>({
    tripId: '',
    occurredAt: '',
  });
  const [recordingTrip, setRecordingTrip] = useState<boolean>(false);
  const [tripErr, setTripErr] = useState<string | null>(null);

  function openTripDialog(): void {
    setTripForm({ tripId: '', occurredAt: new Date().toISOString().slice(0, 16) });
    setTripErr(null);
    setTripOpen(true);
  }

  async function onRecordTrip(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setRecordingTrip(true);
    setTripErr(null);
    try {
      const result = await captainTripsApi.record(captainId, {
        tripId: tripForm.tripId.trim(),
        occurredAt: new Date(tripForm.occurredAt).toISOString(),
      });
      setTripOpen(false);
      setNotice(result.duplicate ? tTrips('duplicate') : tTrips('recorded'));
      await Promise.all([reloadTrips(), reloadCaptain()]);
    } catch (err) {
      setTripErr(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRecordingTrip(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={captain ? captain.name : t('title')}
        subtitle={captain ? captain.phone : undefined}
        actions={
          <Link
            href="/admin/captains"
            className="inline-flex h-9 items-center gap-1 rounded-md border border-surface-border bg-surface-card px-3 text-sm font-medium text-ink-secondary hover:bg-brand-50/60"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('back')}
          </Link>
        }
      />

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="flex border-b border-surface-border">
        {(['summary', 'documents', 'trips'] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'border-b-2 px-3 py-2 text-sm font-medium',
              tab === key
                ? 'border-brand-500 text-brand-700'
                : 'border-transparent text-ink-secondary hover:text-ink-primary',
            )}
          >
            {t(`tabs.${key}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="rounded-lg border border-surface-border bg-surface-card px-4 py-10 text-center text-sm text-ink-secondary shadow-card">
          {tCommon('loading')}
        </p>
      ) : null}

      {!loading && captain && tab === 'summary' ? (
        <section className="grid max-w-2xl grid-cols-2 gap-4 rounded-lg border border-surface-border bg-surface-card p-4 shadow-card">
          <div>
            <p className="text-xs text-ink-tertiary">{tCaptains('status')}</p>
            <Badge tone={captain.status === 'active' ? 'healthy' : 'inactive'}>
              {captain.status}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">{tCaptains('onboardingStatus')}</p>
            <p className="text-sm text-ink-primary">{captain.onboardingStatus}</p>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">ID card</p>
            <Badge tone={captain.hasIdCard ? 'healthy' : 'inactive'}>
              {captain.hasIdCard ? '✓' : '—'}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">License</p>
            <Badge tone={captain.hasLicense ? 'healthy' : 'inactive'}>
              {captain.hasLicense ? '✓' : '—'}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">Vehicle reg.</p>
            <Badge tone={captain.hasVehicleRegistration ? 'healthy' : 'inactive'}>
              {captain.hasVehicleRegistration ? '✓' : '—'}
            </Badge>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">{t('firstTripAt')}</p>
            <p className="text-sm text-ink-primary">
              {captain.firstTripAt
                ? new Date(captain.firstTripAt).toLocaleString()
                : t('noFirstTrip')}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-tertiary">{t('tripCount')}</p>
            <p className="text-sm text-ink-primary">{captain.tripCount}</p>
          </div>
        </section>
      ) : null}

      {!loading && tab === 'documents' ? (
        <section className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button onClick={openUpload}>
              <Plus className="h-4 w-4" />
              {tDocs('uploadButton')}
            </Button>
          </div>
          {documents.length === 0 ? (
            <p className="rounded-md border border-dashed border-surface-border bg-surface-card px-4 py-8 text-center text-sm text-ink-tertiary">
              {tDocs('noDocs')}
            </p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-surface-border bg-surface-card shadow-card">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center gap-3 border-b border-surface-border px-3 py-2.5 text-sm last:border-b-0"
                >
                  <div className="flex flex-1 flex-col gap-0.5">
                    <span className="font-medium text-ink-primary">
                      {doc.fileName} <span className="text-xs text-ink-tertiary">({doc.kind})</span>
                    </span>
                    <span className="text-xs text-ink-tertiary">
                      {doc.mimeType} · {Math.round(doc.sizeBytes / 1024)} KB ·{' '}
                      {new Date(doc.createdAt).toLocaleString()}
                    </span>
                    {doc.reviewer ? (
                      <span className="text-xs text-ink-tertiary">
                        {tDocs('reviewedBy', { name: doc.reviewer.name })}
                      </span>
                    ) : null}
                    {doc.reviewNotes ? (
                      <span className="text-xs italic text-ink-secondary">“{doc.reviewNotes}”</span>
                    ) : null}
                  </div>
                  <Badge tone={statusTone(doc.status)}>{doc.status}</Badge>
                  {doc.status === 'pending' ? (
                    <>
                      <Button size="sm" onClick={() => void onReview(doc, 'approve')}>
                        {tDocs('approve')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void onReview(doc, 'reject')}
                      >
                        {tDocs('reject')}
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void onDeleteDoc(doc)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {!loading && tab === 'trips' ? (
        <section className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button onClick={openTripDialog}>
              <Plus className="h-4 w-4" />
              {tTrips('recordButton')}
            </Button>
          </div>
          {trips.length === 0 ? (
            <p className="rounded-md border border-dashed border-surface-border bg-surface-card px-4 py-8 text-center text-sm text-ink-tertiary">
              {tTrips('noTrips')}
            </p>
          ) : (
            <ul className="flex flex-col rounded-lg border border-surface-border bg-surface-card shadow-card">
              {trips.map((trip) => (
                <li
                  key={trip.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-border px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="font-mono text-xs text-ink-primary">{trip.tripId}</span>
                  <span className="text-xs text-ink-secondary">
                    {new Date(trip.occurredAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Upload modal */}
      <Modal
        open={uploadOpen}
        title={tDocs('uploadTitle')}
        onClose={() => setUploadOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setUploadOpen(false)}>
              {tDocs('cancel')}
            </Button>
            <Button type="submit" form="captainDocUploadForm" loading={uploading}>
              {tDocs('save')}
            </Button>
          </>
        }
      >
        <form id="captainDocUploadForm" className="flex flex-col gap-3" onSubmit={onUpload}>
          {uploadErr ? <Notice tone="error">{uploadErr}</Notice> : null}
          <Field label={tDocs('kind')} required>
            <Select
              value={uploadForm.kind}
              onChange={(e) => setUploadForm((f) => ({ ...f, kind: e.target.value }))}
              required
            >
              {DOC_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tDocs('storageRef')} required>
            <Input
              required
              value={uploadForm.storageRef}
              onChange={(e) => setUploadForm((f) => ({ ...f, storageRef: e.target.value }))}
              maxLength={2048}
            />
          </Field>
          <Field label={tDocs('fileName')} required>
            <Input
              required
              value={uploadForm.fileName}
              onChange={(e) => setUploadForm((f) => ({ ...f, fileName: e.target.value }))}
              maxLength={255}
            />
          </Field>
          <Field label={tDocs('mimeType')} required>
            <Input
              required
              value={uploadForm.mimeType}
              onChange={(e) => setUploadForm((f) => ({ ...f, mimeType: e.target.value }))}
              maxLength={120}
            />
          </Field>
          <Field label={tDocs('sizeBytes')} required>
            <Input
              type="number"
              required
              min={0}
              value={uploadForm.sizeBytes}
              onChange={(e) => setUploadForm((f) => ({ ...f, sizeBytes: e.target.value }))}
            />
          </Field>
          <Field label={tDocs('expiresAt')}>
            <Input
              type="datetime-local"
              value={uploadForm.expiresAt}
              onChange={(e) => setUploadForm((f) => ({ ...f, expiresAt: e.target.value }))}
            />
          </Field>
        </form>
      </Modal>

      {/* Trip record modal */}
      <Modal
        open={tripOpen}
        title={tTrips('recordTitle')}
        onClose={() => setTripOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setTripOpen(false)}>
              {tTrips('cancel')}
            </Button>
            <Button type="submit" form="captainTripForm" loading={recordingTrip}>
              {tTrips('save')}
            </Button>
          </>
        }
      >
        <form id="captainTripForm" className="flex flex-col gap-3" onSubmit={onRecordTrip}>
          {tripErr ? <Notice tone="error">{tripErr}</Notice> : null}
          <Field label={tTrips('tripId')} required>
            <Input
              required
              value={tripForm.tripId}
              onChange={(e) => setTripForm((f) => ({ ...f, tripId: e.target.value }))}
              maxLength={120}
            />
          </Field>
          <Field label={tTrips('occurredAt')} required>
            <Input
              type="datetime-local"
              required
              value={tripForm.occurredAt}
              onChange={(e) => setTripForm((f) => ({ ...f, occurredAt: e.target.value }))}
            />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
