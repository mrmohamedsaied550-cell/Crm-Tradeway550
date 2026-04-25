import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import multipart from '@fastify/multipart';
import { env } from './lib/env';
import { errorHandler } from './middleware/error-handler';
import { authRoutes } from './modules/auth/auth.routes';
import { usersRoutes } from './modules/users/users.routes';
import { companiesRoutes } from './modules/settings/companies.routes';
import { pipelineRoutes } from './modules/settings/pipeline.routes';
import { leadsRoutes } from './modules/leads/leads.routes';
import { campaignsRoutes } from './modules/campaigns/campaigns.routes';
import { webhooksRoutes } from './modules/campaigns/webhooks.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';

async function bootstrap() {
  const app = Fastify({
    logger: env.NODE_ENV === 'production'
      ? true
      : { transport: { target: 'pino-pretty', options: { colorize: true } } },
    bodyLimit: 10 * 1024 * 1024,
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
  });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  app.setErrorHandler(errorHandler);

  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));
  app.get('/', async () => ({ name: 'Trade Way CRM API', version: '1.0.0' }));

  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(usersRoutes, { prefix: '/api/v1/users' });
  await app.register(companiesRoutes, { prefix: '/api/v1/companies' });
  await app.register(pipelineRoutes, { prefix: '/api/v1/pipeline' });
  await app.register(leadsRoutes, { prefix: '/api/v1/leads' });
  await app.register(campaignsRoutes, { prefix: '/api/v1/campaigns' });
  await app.register(webhooksRoutes, { prefix: '/api/v1/webhooks' });
  await app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(`🚀 API ready on http://${env.HOST}:${env.PORT}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
