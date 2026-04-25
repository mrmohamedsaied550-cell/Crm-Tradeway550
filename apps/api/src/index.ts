import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { env } from './config/env.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';

import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import companyRoutes from './modules/companies/routes.js';
import countryRoutes from './modules/countries/routes.js';
import companyCountryRoutes from './modules/company-countries/routes.js';
import contactRoutes from './modules/contacts/routes.js';
import enrollmentRoutes from './modules/enrollments/routes.js';
import pipelineRoutes from './modules/pipeline/routes.js';

async function buildServer() {
  const app = Fastify({
    logger: { level: env.LOG_LEVEL },
    disableRequestLogging: env.NODE_ENV === 'production',
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(errorHandler);
  await app.register(authPlugin);

  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: '/auth' });
      await api.register(userRoutes, { prefix: '/users' });
      await api.register(companyRoutes, { prefix: '/companies' });
      await api.register(countryRoutes, { prefix: '/countries' });
      await api.register(companyCountryRoutes, { prefix: '/company-countries' });
      await api.register(contactRoutes, { prefix: '/contacts' });
      await api.register(enrollmentRoutes, { prefix: '/enrollments' });
      await api.register(pipelineRoutes, { prefix: '/pipeline' });
    },
    { prefix: '/api/v1' },
  );

  return app;
}

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
