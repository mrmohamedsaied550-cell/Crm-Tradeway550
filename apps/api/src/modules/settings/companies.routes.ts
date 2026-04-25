import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { companies, countries, companyCountries } from '../../db/schema/companies';
import { authenticate, requireCapability } from '../../middleware/auth';
import { ConflictError, NotFoundError } from '../../lib/errors';

const createCompanySchema = z.object({
  code: z.string().min(2).max(32),
  nameAr: z.string().min(1).max(120),
  nameEn: z.string().min(1).max(120),
  logoUrl: z.string().url().max(500).optional(),
});

const createCountrySchema = z.object({
  code: z.string().length(2),
  nameAr: z.string().min(1),
  nameEn: z.string().min(1),
  currency: z.string().length(3),
  timezone: z.string(),
  flagEmoji: z.string().optional(),
});

const linkCompanyCountrySchema = z.object({
  companyId: z.string(),
  countryCode: z.string().length(2),
});

export async function companiesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  // ===== Companies =====
  app.get('/', async (_req, reply) => {
    const list = await db.select().from(companies).orderBy(companies.nameAr);
    return reply.send({ items: list });
  });

  app.post('/', { preHandler: requireCapability('companies.manage') }, async (req, reply) => {
    const body = createCompanySchema.parse(req.body);
    const existing = await db.select().from(companies).where(eq(companies.code, body.code)).limit(1);
    if (existing.length > 0) throw new ConflictError('Company code already exists');
    await db.insert(companies).values(body);
    const [created] = await db.select().from(companies).where(eq(companies.code, body.code)).limit(1);
    return reply.status(201).send(created);
  });

  app.put('/:id', { preHandler: requireCapability('companies.manage') }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = createCompanySchema.partial().parse(req.body);
    await db.update(companies).set(body).where(eq(companies.id, id));
    const [updated] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
    if (!updated) throw new NotFoundError('Company');
    return reply.send(updated);
  });

  // ===== Countries =====
  app.get('/countries', async (_req, reply) => {
    const list = await db.select().from(countries).orderBy(countries.nameAr);
    return reply.send({ items: list });
  });

  app.post('/countries', { preHandler: requireCapability('companies.manage') }, async (req, reply) => {
    const body = createCountrySchema.parse(req.body);
    await db.insert(countries).values(body);
    const [created] = await db.select().from(countries).where(eq(countries.code, body.code)).limit(1);
    return reply.status(201).send(created);
  });

  // ===== Company-Countries (the "markets") =====
  app.get('/company-countries', async (_req, reply) => {
    const list = await db.query.companyCountries.findMany({
      with: { company: true, country: true },
    });
    return reply.send({ items: list });
  });

  app.post('/company-countries', { preHandler: requireCapability('companies.manage') }, async (req, reply) => {
    const body = linkCompanyCountrySchema.parse(req.body);
    try {
      await db.insert(companyCountries).values(body);
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'ER_DUP_ENTRY') throw new ConflictError('Already linked');
      throw err;
    }
    return reply.status(201).send({ ok: true });
  });
}
