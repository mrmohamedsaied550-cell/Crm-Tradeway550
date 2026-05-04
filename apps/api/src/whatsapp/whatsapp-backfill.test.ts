/**
 * Phase C — C10B-2: WhatsAppBackfillService tests.
 *
 * Throwaway tenant fixture, mirrors org.test / leads-scope.test:
 *   - one company / one country / one team / one agent (Alice)
 *   - one captain on a converted lead (phone P_CAPTAIN)
 *   - one open lead with assignment (phone P_LINKED)
 *   - one open lead with NO conversation (covers "lead without
 *     conversation gets no contact created from this run")
 *   - three conversations:
 *       • L1 — links to the open lead     → ownership denormalised
 *       • L2 — links to the captain's lead → contact gets isCaptain
 *       • L3 — unlinked (leadId IS NULL)   → contact only, no owner
 *
 * Coverage:
 *   - Contact upsert by (tenantId, phone) — creates the right rows
 *     with originalPhone snapshotted, displayName left NULL.
 *   - Linked conversations get assignedToId / teamId / companyId /
 *     countryId / assignmentSource = 'migrated' / assignedAt set.
 *   - Unlinked conversations get contactId set but stay unowned.
 *   - Captain flag follows from the lead-side captain row.
 *   - hasOpenLead reflects lifecycleState='open'.
 *   - Idempotence: re-run scans the same conversations, never
 *     overwrites a real ('migrated' or other) ownership, only
 *     refreshes denormalised flags.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

import { WhatsAppBackfillService } from './whatsapp-backfill.service';

const TENANT_CODE = '__c10b2_backfill__';

let prisma: PrismaClient;
let svc: WhatsAppBackfillService;
let tenantId: string;
let companyId: string;
let countryId: string;
let teamId: string;
let aliceId: string;
let leadOpenId: string;
let leadCaptainId: string;
let convLinkedId: string;
let convUnlinkedId: string;

async function withTenantRaw<T>(tid: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return prisma.$transaction(async (tx: any) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.tenant_id = '${tid}'`);
    return fn(tx);
  });
}

describe('whatsapp — backfill contacts + ownership (C10B-2)', () => {
  before(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    svc = new WhatsAppBackfillService();

    const tenant = await prisma.tenant.upsert({
      where: { code: TENANT_CODE },
      update: { isActive: true },
      create: { code: TENANT_CODE, name: 'C10B-2 backfill test' },
    });
    tenantId = tenant.id;

    await withTenantRaw(tenantId, async (tx) => {
      // Org structure
      const company = await tx.company.create({
        data: { tenantId, code: 'acme', name: 'ACME' },
      });
      companyId = company.id;
      const country = await tx.country.create({
        data: { tenantId, companyId, code: 'EG', name: 'Egypt' },
      });
      countryId = country.id;
      const team = await tx.team.create({
        data: { tenantId, countryId, name: 'Sales' },
      });
      teamId = team.id;

      // Role + user (Alice)
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: 'sales_agent' } },
        update: {},
        create: {
          tenantId,
          code: 'sales_agent',
          nameAr: 'وكيل',
          nameEn: 'Sales Agent',
          level: 30,
        },
      });
      const alice = await tx.user.create({
        data: {
          tenantId,
          email: 'c10b2-alice@test',
          name: 'Alice',
          passwordHash: 'x',
          status: 'active',
          roleId: role.id,
          teamId,
        },
      });
      aliceId = alice.id;

      // Pipeline + stages (need a non-terminal `new` and a terminal `won`)
      const pipeline = await tx.pipeline.create({
        data: { tenantId, name: 'Default', isDefault: true, isActive: true },
      });
      const stageNew = await tx.pipelineStage.create({
        data: { tenantId, pipelineId: pipeline.id, code: 'new', name: 'New', order: 10 },
      });
      const stageWon = await tx.pipelineStage.create({
        data: {
          tenantId,
          pipelineId: pipeline.id,
          code: 'converted',
          name: 'Converted',
          order: 99,
          isTerminal: true,
          terminalKind: 'won',
        },
      });

      // Open lead, assigned to Alice
      const leadOpen = await tx.lead.create({
        data: {
          tenantId,
          stageId: stageNew.id,
          pipelineId: pipeline.id,
          name: 'Open lead',
          phone: '+201001111111',
          source: 'manual',
          assignedToId: aliceId,
          companyId,
          countryId,
          lifecycleState: 'open',
        },
      });
      leadOpenId = leadOpen.id;

      // Captain lead — won lifecycle + a captain row attached.
      const leadCaptain = await tx.lead.create({
        data: {
          tenantId,
          stageId: stageWon.id,
          pipelineId: pipeline.id,
          name: 'Captain lead',
          phone: '+201002222222',
          source: 'manual',
          assignedToId: aliceId,
          companyId,
          countryId,
          lifecycleState: 'won',
        },
      });
      leadCaptainId = leadCaptain.id;
      await tx.captain.create({
        data: {
          tenantId,
          leadId: leadCaptainId,
          name: 'Captain lead',
          phone: '+201002222222',
          status: 'active',
          onboardingStatus: 'in_progress',
          teamId,
        },
      });

      // WhatsApp account
      const account = await tx.whatsAppAccount.create({
        data: {
          tenantId,
          displayName: 'Test Acc',
          phoneNumber: '+200000000000',
          phoneNumberId: 'PNID-C10B2',
          provider: 'meta_cloud',
          accessToken: 'tok',
          verifyToken: 'verify',
        },
      });

      // Three conversations.
      const convLinked = await tx.whatsAppConversation.create({
        data: {
          tenantId,
          accountId: account.id,
          phone: '+201001111111',
          leadId: leadOpenId,
        },
      });
      convLinkedId = convLinked.id;

      await tx.whatsAppConversation.create({
        data: {
          tenantId,
          accountId: account.id,
          phone: '+201002222222',
          leadId: leadCaptainId,
        },
      });

      const convUnlinked = await tx.whatsAppConversation.create({
        data: {
          tenantId,
          accountId: account.id,
          phone: '+201009999999',
          leadId: null,
        },
      });
      convUnlinkedId = convUnlinked.id;
    });
  });

  after(async () => {
    await prisma.tenant.delete({ where: { code: TENANT_CODE } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('creates one Contact per distinct phone with originalPhone snapshotted', async () => {
    const report = await svc.backfillTenant(prisma, tenantId);

    assert.equal(report.tenantId, tenantId);
    assert.equal(report.contactsCreated, 3, 'three distinct phones across the conversations');
    assert.equal(report.contactsUpdated, 0);

    const contacts = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findMany({ where: { tenantId }, orderBy: { phone: 'asc' } }),
    );
    assert.equal(contacts.length, 3);
    for (const c of contacts) {
      assert.equal(c.phone, c.originalPhone, 'originalPhone snapshots phone at create');
      assert.equal(c.displayName, null, 'displayName left NULL — never captured historically');
      assert.equal(c.originalDisplayName, null);
    }
  });

  it('linked conversation gets full ownership denormalised + assignmentSource=migrated', async () => {
    // Idempotent: re-running picks up the row written above and only
    // refreshes denormalised flags. The row already has
    // assignmentSource='migrated', so the second call MUST NOT
    // re-write ownership.
    const conv = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: convLinkedId } }),
    );
    assert.ok(conv);
    assert.equal(conv?.contactId !== null, true);
    assert.equal(conv?.assignedToId, aliceId);
    assert.equal(conv?.teamId, teamId);
    assert.equal(conv?.companyId, companyId);
    assert.equal(conv?.countryId, countryId);
    assert.equal(conv?.assignmentSource, 'migrated');
    assert.ok(conv?.assignedAt);
  });

  it('captain phone ⇒ contact.isCaptain=true; non-captain stays false', async () => {
    const captainContact = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({
        where: { tenantId_phone: { tenantId, phone: '+201002222222' } },
      }),
    );
    assert.equal(captainContact?.isCaptain, true);
    assert.equal(captainContact?.hasOpenLead, false, 'captain lead is in won lifecycle');

    const openContact = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({
        where: { tenantId_phone: { tenantId, phone: '+201001111111' } },
      }),
    );
    assert.equal(openContact?.isCaptain, false);
    assert.equal(openContact?.hasOpenLead, true);

    const unlinkedContact = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({
        where: { tenantId_phone: { tenantId, phone: '+201009999999' } },
      }),
    );
    assert.equal(unlinkedContact?.isCaptain, false);
    assert.equal(unlinkedContact?.hasOpenLead, false, 'no lead matches the unlinked phone');
  });

  it('unlinked conversation: contactId set, ownership stays NULL', async () => {
    const conv = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: convUnlinkedId } }),
    );
    assert.ok(conv?.contactId);
    assert.equal(conv?.assignedToId, null);
    assert.equal(conv?.teamId, null);
    assert.equal(conv?.companyId, null);
    assert.equal(conv?.countryId, null);
    assert.equal(conv?.assignmentSource, null);
    assert.equal(conv?.assignedAt, null);
  });

  it('idempotent re-run: counts updated contacts, never overwrites real ownership', async () => {
    const first = await svc.backfillTenant(prisma, tenantId);
    // First re-run after the initial in test #1: nothing new to
    // create, but every contact gets refresh-style updates.
    assert.equal(first.contactsCreated, 0);
    assert.equal(first.contactsUpdated, 3);
    // The linked + captain conversations already carry
    // assignmentSource='migrated' from the initial run, so the
    // re-run reports them as already-owned and writes nothing.
    assert.equal(first.conversationsAlreadyOwned, 2);
    assert.equal(first.conversationsUnlinked, 1);
    assert.equal(first.conversationsOwnershipDenormalised, 0, 'ownership writes happen only once');

    // Verify the assignedAt timestamp didn't move on the linked row.
    const conv = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({
        where: { id: convLinkedId },
        select: { assignedAt: true, assignedToId: true },
      }),
    );
    assert.ok(conv?.assignedAt);
    assert.equal(conv?.assignedToId, aliceId);
  });

  it('idempotent re-run: a real (non-migrated) assignment is preserved', async () => {
    // Manually flip the unlinked conversation to assignmentSource='manual_handover'
    // (simulating a future state where C10B-4 has run a real
    // handover). The next backfill MUST NOT overwrite it.
    await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.update({
        where: { id: convUnlinkedId },
        data: {
          assignedToId: aliceId,
          teamId,
          companyId,
          countryId,
          assignmentSource: 'manual_handover',
          assignedAt: new Date('2026-01-01T00:00:00Z'),
        },
      }),
    );

    const before = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: convUnlinkedId } }),
    );
    const beforeAssignedAt = before?.assignedAt;

    const report = await svc.backfillTenant(prisma, tenantId);
    assert.equal(report.conversationsAlreadyOwned, 3, 'all three conversations now owned');
    assert.equal(report.conversationsOwnershipDenormalised, 0);
    assert.equal(report.conversationsUnlinked, 0);

    const after = await withTenantRaw(tenantId, (tx) =>
      tx.whatsAppConversation.findUnique({ where: { id: convUnlinkedId } }),
    );
    assert.equal(after?.assignmentSource, 'manual_handover', 'never overwritten');
    assert.equal(after?.assignedAt?.getTime(), beforeAssignedAt?.getTime());
  });

  it('captain status=archived stops counting toward isCaptain on next run', async () => {
    // Edge case: a captain row that was deactivated must NOT keep
    // routing the contact to the review queue forever. Backfill
    // re-runs reset isCaptain when the captain is no longer active.
    await withTenantRaw(tenantId, (tx) =>
      tx.captain.update({
        where: { leadId: leadCaptainId },
        data: { status: 'archived' },
      }),
    );

    await svc.backfillTenant(prisma, tenantId);

    const captainContact = await withTenantRaw(tenantId, (tx) =>
      tx.contact.findUnique({
        where: { tenantId_phone: { tenantId, phone: '+201002222222' } },
      }),
    );
    assert.equal(captainContact?.isCaptain, false, 'archived captain ⇒ contact.isCaptain=false');
  });

  it('multi-tenant: backfillAll iterates active tenants and isolates them', async () => {
    // Spin up a second tenant with a single conversation; backfillAll
    // should report two tenants and not bleed contacts across.
    const otherCode = '__c10b2_backfill_other__';
    const other = await prisma.tenant.upsert({
      where: { code: otherCode },
      update: { isActive: true },
      create: { code: otherCode, name: 'C10B-2 backfill other tenant' },
    });
    try {
      await withTenantRaw(other.id, async (tx) => {
        const account = await tx.whatsAppAccount.create({
          data: {
            tenantId: other.id,
            displayName: 'Other Acc',
            phoneNumber: '+966000000000',
            phoneNumberId: 'PNID-OTHER',
            provider: 'meta_cloud',
            accessToken: 'tok',
            verifyToken: 'verify',
          },
        });
        await tx.whatsAppConversation.create({
          data: {
            tenantId: other.id,
            accountId: account.id,
            phone: '+966500000001',
            leadId: null,
          },
        });
      });

      const report = await svc.backfillAll(prisma);
      assert.ok(report.tenantsScanned >= 2);
      // Cross-tenant isolation: the test tenant's contacts must not
      // include the other tenant's phone.
      const testContacts = await withTenantRaw(tenantId, (tx) =>
        tx.contact.findMany({ where: { tenantId } }),
      );
      const phones = testContacts.map((c) => c.phone);
      assert.equal(phones.includes('+966500000001'), false);
    } finally {
      await prisma.tenant.delete({ where: { code: otherCode } }).catch(() => {});
    }
  });
});
