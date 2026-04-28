import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService, type HealthStatus } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Operational health probe',
    description:
      'Returns service liveness plus the status of downstream dependencies. ' +
      'C6 adds a soft database ping; Redis is still reported as "n/a" until C8.',
  })
  @ApiOkResponse({
    description: 'Service is up.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        db: { type: 'string', enum: ['ok', 'fail', 'n/a'], example: 'ok' },
        redis: { type: 'string', enum: ['ok', 'fail', 'n/a'], example: 'n/a' },
        version: { type: 'string', example: '0.0.0' },
      },
      required: ['status', 'db', 'redis', 'version'],
    },
  })
  get(): Promise<HealthStatus> {
    return this.health.status();
  }
}
