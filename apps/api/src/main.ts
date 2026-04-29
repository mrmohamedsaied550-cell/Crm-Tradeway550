import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger, RequestMethod } from '@nestjs/common';
import { Logger as PinoLogger } from 'nestjs-pino';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/error-filter';
import { ZodValidationPipe } from './common/zod-pipe';
import { buildCorsOptions } from './common/cors';
import { setupOpenApi } from './common/openapi';

const DEFAULT_PORT = 3000;
const API_GLOBAL_PREFIX = 'api/v1';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    cors: false, // we wire CORS explicitly below
    // Preserves req.rawBody alongside the parsed JSON body so the WhatsApp
    // webhook can verify Meta's HMAC signature against the original bytes
    // (re-stringifying the parsed body is unreliable across providers).
    rawBody: true,
  });

  // Replace the default Nest logger with Pino so HTTP requests get structured.
  app.useLogger(app.get(PinoLogger));

  // Global API prefix; /health is intentionally root-level so platform health
  // probes (Railway's healthcheckPath: /health) hit it without an /api/v1
  // dependency.
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: [{ path: 'health', method: RequestMethod.ALL }],
  });

  // Global validation: zod-backed pipe; transform = true coerces query/path
  // values where the schema expects.
  app.useGlobalPipes(new ZodValidationPipe());

  // Global error filter: standardized envelope { code, message, details, request_id }.
  app.useGlobalFilters(new GlobalExceptionFilter());

  // CORS allowlist from CORS_ALLOWED_ORIGINS.
  app.enableCors(buildCorsOptions(process.env));

  // OpenAPI: spec at /api/v1/openapi.json, Swagger UI at /api/v1/docs.
  setupOpenApi(app);

  // Graceful shutdown for SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const portRaw = process.env['PORT'];
  const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
  if (Number.isNaN(port)) {
    throw new Error(`Invalid PORT value: ${portRaw}`);
  }

  await app.listen(port);

  const logger = new NestLogger('bootstrap');
  logger.log(`API listening on http://localhost:${port}`);
  logger.log(`Health:  http://localhost:${port}/health`);
  logger.log(`OpenAPI: http://localhost:${port}/${API_GLOBAL_PREFIX}/openapi.json`);
  logger.log(`Docs:    http://localhost:${port}/${API_GLOBAL_PREFIX}/docs`);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
