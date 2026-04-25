import { and, asc, desc, eq, isNull, like, or, sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { contacts } from '../../db/schema/contacts';
import { enrollments } from '../../db/schema/enrollments';
import { activities } from '../../db/schema/activities';
import type { Scope } from '../../lib/rbac';
import { ConflictError, NotFoundError } from '../../lib/errors';

export interface ListLeadsParams {
  scope: Scope;
  search?: string;
  companyCountryId?: string;
  stageId?: string;
  statusId?: string;
  assignedUserId?: string;
  subStatus?: string;
  page?: number;
  pageSize?: number;
  sortBy?: 'createdAt' | 'updatedAt' | 'nextFollowUpAt';
  sortDir?: 'asc' | 'desc';
}

export class LeadsService {
  async list(params: ListLeadsParams) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 25, 100);

    const conds = [isNull(enrollments.deletedAt)];

    // RBAC scope
    switch (params.scope.type) {
      case 'all':
        break;
      case 'country':
        conds.push(eq(contacts.countryCode, params.scope.countryCode));
        break;
      case 'team':
        // team scope handled later via team's user list — placeholder
        break;
      case 'self':
        conds.push(eq(enrollments.assignedUserId, params.scope.userId));
        break;
    }

    if (params.companyCountryId) conds.push(eq(enrollments.companyCountryId, params.companyCountryId));
    if (params.stageId) conds.push(eq(enrollments.currentStageId, params.stageId));
    if (params.statusId) conds.push(eq(enrollments.currentStatusId, params.statusId));
    if (params.assignedUserId) conds.push(eq(enrollments.assignedUserId, params.assignedUserId));
    if (params.subStatus) {
      conds.push(eq(enrollments.subStatus, params.subStatus as 'active'));
    }
    if (params.search) {
      const s = `%${params.search}%`;
      conds.push(
        or(like(contacts.fullName, s), like(contacts.phone, s), like(contacts.email, s))!,
      );
    }

    const where = and(...conds);
    const sortField =
      params.sortBy === 'updatedAt'
        ? enrollments.updatedAt
        : params.sortBy === 'nextFollowUpAt'
          ? enrollments.nextFollowUpAt
          : enrollments.createdAt;
    const sort = params.sortDir === 'asc' ? asc(sortField) : desc(sortField);

    const rows = await db
      .select({
        enrollment: enrollments,
        contact: contacts,
      })
      .from(enrollments)
      .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
      .where(where)
      .orderBy(sort)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)` })
      .from(enrollments)
      .innerJoin(contacts, eq(enrollments.contactId, contacts.id))
      .where(where);

    return {
      items: rows.map((r) => ({ ...r.enrollment, contact: r.contact })),
      page,
      pageSize,
      total: Number(total),
    };
  }

  async get(id: string) {
    const row = await db.query.enrollments.findFirst({
      where: and(eq(enrollments.id, id), isNull(enrollments.deletedAt)),
      with: {
        contact: true,
        currentStage: true,
        currentStatus: true,
        assignedUser: true,
        rejectReason: true,
        documents: true,
      },
    });
    if (!row) throw new NotFoundError('Lead');
    return row;
  }

  async checkDuplicate(phone: string) {
    const [existing] = await db.select().from(contacts).where(eq(contacts.phone, phone)).limit(1);
    if (!existing) return { exists: false };
    const enrolls = await db.query.enrollments.findMany({
      where: and(eq(enrollments.contactId, existing.id), isNull(enrollments.deletedAt)),
      with: { companyCountry: { with: { company: true, country: true } } },
    });
    return { exists: true, contact: existing, enrollments: enrolls };
  }

  async create(input: {
    contact: {
      fullName: string;
      phone: string;
      whatsapp?: string;
      email?: string;
      city?: string;
      countryCode: string;
      vehicleType?: 'car' | 'motorcycle' | 'van' | 'other';
    };
    enrollment: {
      companyCountryId: string;
      source?: string;
      sourceCode?: string;
      campaignId?: string;
      assignedUserId?: string;
      currentStageId?: string;
      currentStatusId?: string;
    };
    actorId: string | undefined;
    allowExistingContact?: boolean;
  }) {
    const existing = await db
      .select()
      .from(contacts)
      .where(eq(contacts.phone, input.contact.phone))
      .limit(1);

    let contactId: string;
    if (existing.length > 0) {
      if (!input.allowExistingContact) {
        throw new ConflictError('Contact already exists', { contactId: existing[0]!.id });
      }
      contactId = existing[0]!.id;
    } else {
      await db.insert(contacts).values(input.contact);
      const [created] = await db
        .select()
        .from(contacts)
        .where(eq(contacts.phone, input.contact.phone))
        .limit(1);
      contactId = created!.id;
    }

    // Prevent duplicate enrollment in the same company-country.
    const dupEnroll = await db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.contactId, contactId),
          eq(enrollments.companyCountryId, input.enrollment.companyCountryId),
          isNull(enrollments.deletedAt),
        ),
      )
      .limit(1);
    if (dupEnroll.length > 0) {
      throw new ConflictError('Already enrolled in this company-country', {
        enrollmentId: dupEnroll[0]!.id,
      });
    }

    await db.insert(enrollments).values({
      contactId,
      companyCountryId: input.enrollment.companyCountryId,
      source: input.enrollment.source,
      sourceCode: input.enrollment.sourceCode,
      campaignId: input.enrollment.campaignId,
      assignedUserId: input.enrollment.assignedUserId,
      assignedAt: input.enrollment.assignedUserId ? new Date() : undefined,
      currentStageId: input.enrollment.currentStageId,
      currentStatusId: input.enrollment.currentStatusId,
    });

    const [enrollment] = await db
      .select()
      .from(enrollments)
      .where(
        and(
          eq(enrollments.contactId, contactId),
          eq(enrollments.companyCountryId, input.enrollment.companyCountryId),
        ),
      )
      .orderBy(desc(enrollments.createdAt))
      .limit(1);

    await db.insert(activities).values({
      enrollmentId: enrollment!.id,
      actorId: input.actorId,
      type: 'created',
      summary: 'Lead created',
      data: { source: input.enrollment.source ?? 'manual' },
    });

    return enrollment!;
  }

  async update(id: string, actorId: string, patch: Partial<{
    currentStageId: string;
    currentStatusId: string;
    subStatus: 'active' | 'waiting_approval' | 'waiting_customer' | 'cold' | 'paused' | 'completed' | 'dropped';
    assignedUserId: string | null;
    rejectReasonId: string | null;
    rejectNote: string | null;
    nextFollowUpAt: Date | null;
    lastContactAt: Date | null;
  }>) {
    const before = await this.get(id);

    const updateData: Partial<typeof enrollments.$inferInsert> = { ...patch };
    if (patch.assignedUserId !== undefined) {
      updateData.assignedAt = patch.assignedUserId ? new Date() : null;
    }
    await db.update(enrollments).set(updateData).where(eq(enrollments.id, id));

    if (patch.currentStageId && patch.currentStageId !== before.currentStageId) {
      await db.insert(activities).values({
        enrollmentId: id,
        actorId,
        type: 'stage_change',
        summary: 'Stage changed',
        data: { from: before.currentStageId, to: patch.currentStageId },
      });
    }
    if (patch.currentStatusId && patch.currentStatusId !== before.currentStatusId) {
      await db.insert(activities).values({
        enrollmentId: id,
        actorId,
        type: 'status_change',
        summary: 'Status changed',
        data: { from: before.currentStatusId, to: patch.currentStatusId },
      });
    }
    if (patch.assignedUserId !== undefined && patch.assignedUserId !== before.assignedUserId) {
      await db.insert(activities).values({
        enrollmentId: id,
        actorId,
        type: 'assignment_change',
        summary: 'Assignee changed',
        data: { from: before.assignedUserId, to: patch.assignedUserId },
      });
    }

    return this.get(id);
  }

  async addNote(enrollmentId: string, actorId: string, body: string) {
    await db.insert(activities).values({
      enrollmentId,
      actorId,
      type: 'note',
      summary: body.slice(0, 500),
      data: { body },
    });
  }

  async logCall(enrollmentId: string, actorId: string, input: {
    outcome: string;
    durationSec?: number;
    notes?: string;
  }) {
    await db.insert(activities).values({
      enrollmentId,
      actorId,
      type: 'call',
      summary: input.outcome,
      durationSec: input.durationSec,
      data: { notes: input.notes },
    });
    await db
      .update(enrollments)
      .set({ lastContactAt: new Date() })
      .where(eq(enrollments.id, enrollmentId));
  }

  async getTimeline(enrollmentId: string) {
    return db.query.activities.findMany({
      where: eq(activities.enrollmentId, enrollmentId),
      with: { actor: true },
      orderBy: (a, { desc }) => desc(a.createdAt),
      limit: 100,
    });
  }

  async softDelete(id: string) {
    await db.update(enrollments).set({ deletedAt: new Date() }).where(eq(enrollments.id, id));
  }
}
