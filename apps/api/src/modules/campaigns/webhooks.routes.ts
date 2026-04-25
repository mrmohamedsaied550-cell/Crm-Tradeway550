import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { campaigns } from '../../db/schema/campaigns';
import { LeadsService } from '../leads/leads.service';
import { RoutingService } from './routing.service';
import { env } from '../../lib/env';
import { NotFoundError, UnauthorizedError } from '../../lib/errors';

/**
 * Webhook endpoints for Meta, TikTok, and a generic JSON ingestion.
 * Secured per-campaign via a `webhookSecret` query parameter.
 *
 * Meta sends a GET handshake with hub.challenge — we echo it back.
 */
export async function webhooksRoutes(app: FastifyInstance) {
  const leads = new LeadsService();
  const routing = new RoutingService();

  // ===== Meta Lead Ads handshake =====
  app.get('/meta/:campaignId', async (req, reply) => {
    const q = z.object({
      'hub.mode': z.string().optional(),
      'hub.verify_token': z.string().optional(),
      'hub.challenge': z.string().optional(),
    }).parse(req.query);

    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.status(200).send(q['hub.challenge'] ?? 'ok');
    }
    return reply.status(403).send('forbidden');
  });

  // ===== Meta lead ingest =====
  app.post('/meta/:campaignId', async (req, reply) => {
    const { campaignId } = z.object({ campaignId: z.string() }).parse(req.params);
    const { secret } = z.object({ secret: z.string() }).parse(req.query);

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.webhookSecret !== secret) throw new UnauthorizedError();

    // Meta payload structure (simplified): { entry: [{ changes: [{ value: { leadgen_id, ... } }] }] }
    // For now we accept a normalized fallback shape too.
    const body = req.body as {
      fullName?: string;
      phone?: string;
      email?: string;
      city?: string;
      countryCode?: string;
      [k: string]: unknown;
    };

    if (!body.phone || !body.fullName) {
      return reply.status(400).send({ error: 'BAD_PAYLOAD', message: 'phone and fullName required' });
    }

    const assignee = await routing.pickAssignee(campaign.id);

    try {
      const created = await leads.create({
        contact: {
          fullName: body.fullName,
          phone: body.phone,
          email: body.email,
          city: body.city,
          countryCode: body.countryCode ?? 'EG',
        },
        enrollment: {
          companyCountryId: campaign.companyCountryId,
          source: 'meta',
          sourceCode: campaign.code,
          campaignId: campaign.id,
          assignedUserId: assignee ?? undefined,
        },
        // System ingestion — no actor user.
      actorId: undefined,
        allowExistingContact: true,
      });
      return reply.status(201).send({ ok: true, enrollmentId: created.id });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'CONFLICT') {
        return reply.status(200).send({ ok: true, duplicate: true });
      }
      throw err;
    }
  });

  // ===== TikTok lead ingest =====
  app.post('/tiktok/:campaignId', async (req, reply) => {
    const { campaignId } = z.object({ campaignId: z.string() }).parse(req.params);
    const { secret } = z.object({ secret: z.string() }).parse(req.query);

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.webhookSecret !== secret) throw new UnauthorizedError();

    return reply.status(202).send({ ok: true, message: 'TikTok webhook accepted (parser pending)' });
  });

  // ===== Generic JSON ingest (testing + Sheets bridge) =====
  app.post('/generic/:campaignId', async (req, reply) => {
    const { campaignId } = z.object({ campaignId: z.string() }).parse(req.params);
    const { secret } = z.object({ secret: z.string() }).parse(req.query);

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!campaign) throw new NotFoundError('Campaign');
    if (campaign.webhookSecret !== secret) throw new UnauthorizedError();

    const body = z.object({
      fullName: z.string(),
      phone: z.string(),
      email: z.string().email().optional(),
      city: z.string().optional(),
      countryCode: z.string().length(2).default('EG'),
    }).parse(req.body);

    const assignee = await routing.pickAssignee(campaign.id);
    const created = await leads.create({
      contact: body,
      enrollment: {
        companyCountryId: campaign.companyCountryId,
        source: campaign.platform,
        sourceCode: campaign.code,
        campaignId: campaign.id,
        assignedUserId: assignee ?? undefined,
      },
      // System ingestion — no actor user.
      actorId: undefined,
      allowExistingContact: true,
    });
    return reply.status(201).send({ ok: true, enrollmentId: created.id });
  });
}
