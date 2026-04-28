import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { patchNestJsSwagger } from 'nestjs-zod';

/**
 * Wires the OpenAPI spec for the API.
 *
 *   - JSON document:  GET /api/v1/openapi.json
 *   - Swagger UI:     GET /api/v1/docs
 *
 * `patchNestjsSwagger()` teaches @nestjs/swagger how to render zod-derived DTOs
 * (via nestjs-zod's createZodDto) so future endpoints documented with zod
 * appear correctly in the spec.
 */
export function setupOpenApi(app: INestApplication): void {
  patchNestJsSwagger();

  const config = new DocumentBuilder()
    .setTitle('Trade Way / Captain Masr CRM API')
    .setDescription(
      'Internal API for the Trade Way captain acquisition & activation CRM. ' +
        'C3 ships only the operational surface (/health). Business endpoints are added in later chunks.',
    )
    .setVersion('0.0.0')
    .addServer('/api/v1', 'API v1')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/v1/docs', app, document, {
    jsonDocumentUrl: 'api/v1/openapi.json',
    swaggerOptions: { displayRequestDuration: true },
  });
}
