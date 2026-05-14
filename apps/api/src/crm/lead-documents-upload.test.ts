/**
 * Sprint 16 (D16) — Lead Documents upload + download tests.
 *
 * Service-level coverage for the new uploadFile() + openFileForDownload()
 * paths. Tests run against a real Postgres database (same fixture
 * pattern as the Sprint 12 lead-documents.test.ts) and a real local
 * disk storage provider rooted in a temp directory.
 *
 * Scope:
 *   - upload of an allowed MIME persists bytes + metadata + emits
 *     audit / activity rows.
 *   - upload of a disallowed MIME is rejected with the typed code.
 *   - upload of an oversized file is rejected.
 *   - replacement upload bumps the file hash but keeps the row id.
 *   - download streams identical bytes back.
 *   - download of a row without a file returns the typed file_missing
 *     code.
 *   - cross-tenant document id is invisible.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildLocalProvider, StorageService } from '../storage/storage.service';
import { tenantContext } from '../tenants/tenant-context';

import { LeadDocumentsService } from './lead-documents.service';
import { LeadsService } from './leads.service';

const TENANT_CODE = '__d16_upload__';
const OTHER_TENANT_CODE = '__d16_upload_other__';

let prisma: PrismaClient;
let prismaSvc: PrismaService;
let audit: AuditService;
let svc: LeadDocumentsService;
let storageRoot: string;

let tenantId: string;
let otherTenantId: string;
let leadId: string;
let actorUserId: string;
let documentId: string;
let otherTenantDocumentId: string;

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run({ tenantId, tenantCode: TENANT_CODE, source: 'header' }, fn);
}

async function rawTx<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('crm — lead document upload / download (Sprint 16 / D16)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    prismaSvc = new PrismaService();
    audit = new AuditService(prismaSvc);
    storageRoot = await mkdtemp(join(tmpdir(), 'd16-upload-'));
    const storage = StorageService.withProvider(buildLocalProvider(storageRoot));

    const stubLeads = {
      async findByIdInScopeOrThrow(id: string) {
        return prismaSvc.withTenant(tenantId, async (tx) => {
          const lead = await tx.lead.findFirst({ where: { id } });
          if (!lead) {
            const { NotFoundException } = await import('@nestjs/common');
            throw new NotFoundException({
              code: 'lead.not_found',
              message: `Lead ${id} not found`,
            });
          }
          return lead;
        });
      },
    } as unknown as LeadsService;

    svc = new LeadDocumentsService(prismaSvc, stubLeads, audit, storage);

    const t = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'D16 upload test' },
    });
    tenantId = t.id;
    const o = await prisma.tenant.upsert({
      where: { code: OTHER_TENANT_CODE },
      update: { isActive: true },
      create: { code: OTHER_TENANT_CODE, name: 'D16 upload other' },
    });
    otherTenantId = o.id;

    // Roles + actor.
    const role = await rawTx(tenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    const otherRole = await rawTx(otherTenantId, (tx) =>
      tx.role.upsert({
        where: { tenantId_code: { tenantId: otherTenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId: otherTenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      }),
    );
    const actor = await rawTx(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          email: `d16-actor-${Date.now()}@example.com`,
          name: 'D16 actor',
          passwordHash: 'x',
          roleId: role.id,
          status: 'active',
        },
      }),
    );
    actorUserId = actor.id;

    // Lead bootstrap (mirrors the Sprint 12 test pattern).
    const pipeline = await rawTx(tenantId, (tx) =>
      tx.pipeline.create({ data: { tenantId, name: 'D16 PL', isDefault: true } }),
    );
    const stage = await rawTx(tenantId, (tx) =>
      tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'fresh',
          name: 'Fresh',
          order: 1,
          isTerminal: false,
        },
      }),
    );
    const contact = await rawTx(tenantId, (tx) =>
      tx.contact.create({
        data: { tenantId, phone: '+201000099001', originalPhone: '+201000099001' },
      }),
    );
    const lead = await rawTx(tenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId,
          contactId: contact.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          assignedToId: actor.id,
          name: 'D16 Lead',
          phone: '+201000099001',
        },
      }),
    );
    leadId = lead.id;

    // Document row to upload against.
    const doc = await rawTx(tenantId, (tx) =>
      tx.leadDocument.create({
        data: {
          tenantId,
          leadId,
          type: 'national_id',
          status: 'missing',
          uploadedById: actor.id,
        },
      }),
    );
    documentId = doc.id;

    // Cross-tenant doc for isolation test.
    const oPipeline = await rawTx(otherTenantId, (tx) =>
      tx.pipeline.create({
        data: { tenantId: otherTenantId, name: 'Other PL', isDefault: true },
      }),
    );
    const oStage = await rawTx(otherTenantId, (tx) =>
      tx.pipelineStage.create({
        data: {
          tenantId: otherTenantId,
          pipelineId: oPipeline.id,
          code: 'fresh',
          name: 'Fresh',
          order: 1,
          isTerminal: false,
        },
      }),
    );
    const oContact = await rawTx(otherTenantId, (tx) =>
      tx.contact.create({
        data: {
          tenantId: otherTenantId,
          phone: '+201000099999',
          originalPhone: '+201000099999',
        },
      }),
    );
    const oLead = await rawTx(otherTenantId, (tx) =>
      tx.lead.create({
        data: {
          tenantId: otherTenantId,
          contactId: oContact.id,
          pipelineId: oPipeline.id,
          stageId: oStage.id,
          name: 'Other Lead',
          phone: '+201000099999',
        },
      }),
    );
    const oRole = otherRole; // referenced to keep typecheck happy
    void oRole;
    const oDoc = await rawTx(otherTenantId, (tx) =>
      tx.leadDocument.create({
        data: {
          tenantId: otherTenantId,
          leadId: oLead.id,
          type: 'national_id',
          status: 'missing',
        },
      }),
    );
    otherTenantDocumentId = oDoc.id;
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.tenant.delete({ where: { code: OTHER_TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('uploadFile() persists bytes + metadata + emits audit + activity', async () => {
    const buf = Buffer.from('PDF-PAYLOAD-1234567890');
    await inTenant(() =>
      svc.uploadFile(
        leadId,
        documentId,
        { buffer: buf, mimeType: 'application/pdf', originalName: 'national-id.pdf' },
        { userId: actorUserId, tenantId, roleId: 'role' },
      ),
    );
    const row = await rawTx(tenantId, (tx) =>
      tx.leadDocument.findUniqueOrThrow({ where: { id: documentId } }),
    );
    assert.equal(row.status, 'uploaded');
    assert.equal(row.fileName, 'national-id.pdf');
    assert.equal(row.mimeType, 'application/pdf');
    assert.equal(row.sizeBytes, buf.length);
    assert.equal(row.storageProvider, 'local');
    assert.match(row.fileHash ?? '', /^[0-9a-f]{64}$/u);
    assert.ok(row.storageKey?.startsWith(`leads/${tenantId}/${leadId}/${documentId}-`));

    const audits = await rawTx(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId, action: 'lead.document.file_uploaded', entityId: documentId },
      }),
    );
    assert.equal(audits.length, 1);
    const activities = await rawTx(tenantId, (tx) =>
      tx.leadActivity.findMany({
        where: { tenantId, leadId, body: { contains: 'national_id file uploaded' } },
      }),
    );
    assert.equal(activities.length, 1);
  });

  it('uploadFile() rejects disallowed MIME with lead.document.unsupported_type', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.uploadFile(
            leadId,
            documentId,
            {
              buffer: Buffer.from('exe'),
              mimeType: 'application/x-msdownload',
              originalName: 'evil.exe',
            },
            { userId: actorUserId, tenantId, roleId: 'role' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.unsupported_type';
      },
    );
  });

  it('uploadFile() rejects oversized files with lead.document.too_large', async () => {
    process.env['DOCUMENT_UPLOAD_MAX_BYTES'] = '16';
    try {
      await assert.rejects(
        () =>
          inTenant(() =>
            svc.uploadFile(
              leadId,
              documentId,
              {
                buffer: Buffer.alloc(64, 0x41),
                mimeType: 'application/pdf',
                originalName: 'big.pdf',
              },
              { userId: actorUserId, tenantId, roleId: 'role' },
            ),
          ),
        (err: unknown) => {
          const e = err as { response?: { code?: string } };
          return e.response?.code === 'lead.document.too_large';
        },
      );
    } finally {
      delete process.env['DOCUMENT_UPLOAD_MAX_BYTES'];
    }
  });

  it('uploadFile() replacement keeps row id, swaps fileHash, audits as file_replaced', async () => {
    const next = Buffer.from('PDF-PAYLOAD-REPLACED');
    await inTenant(() =>
      svc.uploadFile(
        leadId,
        documentId,
        { buffer: next, mimeType: 'application/pdf', originalName: 'replaced.pdf' },
        { userId: actorUserId, tenantId, roleId: 'role' },
      ),
    );
    const row = await rawTx(tenantId, (tx) =>
      tx.leadDocument.findUniqueOrThrow({ where: { id: documentId } }),
    );
    assert.equal(row.fileName, 'replaced.pdf');
    const audits = await rawTx(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId, action: 'lead.document.file_replaced', entityId: documentId },
      }),
    );
    assert.equal(audits.length, 1);
  });

  it('openFileForDownload() streams the latest bytes back', async () => {
    const opened = await inTenant(() =>
      svc.openFileForDownload(leadId, documentId, {
        userId: actorUserId,
        tenantId,
        roleId: 'role',
      }),
    );
    assert.equal(opened.fileName, 'replaced.pdf');
    assert.equal(opened.mimeType, 'application/pdf');
    const read = await streamToBuffer(opened.stream);
    assert.deepEqual(read, Buffer.from('PDF-PAYLOAD-REPLACED'));
  });

  it('openFileForDownload() throws lead.document.file_missing for an un-uploaded row', async () => {
    const emptyDoc = await rawTx(tenantId, (tx) =>
      tx.leadDocument.create({
        data: { tenantId, leadId, type: 'driving_license', status: 'missing' },
      }),
    );
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.openFileForDownload(leadId, emptyDoc.id, {
            userId: actorUserId,
            tenantId,
            roleId: 'role',
          }),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.file_missing';
      },
    );
  });

  it('cross-tenant document id is invisible to upload + download', async () => {
    await assert.rejects(
      () =>
        inTenant(() =>
          svc.uploadFile(
            leadId,
            otherTenantDocumentId,
            { buffer: Buffer.from('x'), mimeType: 'application/pdf', originalName: 'x.pdf' },
            { userId: actorUserId, tenantId, roleId: 'role' },
          ),
        ),
      (err: unknown) => {
        const e = err as { response?: { code?: string } };
        return e.response?.code === 'lead.document.not_found';
      },
    );
  });
});
