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
      'In C3 the database and Redis are reported as "n/a"; live checks land in C8/C12.',
  })
  @ApiOkResponse({
    description: 'Service is up.',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', example: 'ok' },
        db: { type: 'string', enum: ['ok', 'fail', 'n/a'], example: 'n/a' },
        redis: { type: 'string', enum: ['ok', 'fail', 'n/a'], example: 'n/a' },
        version: { type: 'string', example: '0.0.0' },
      },
      required: ['status', 'db', 'redis', 'version'],
    },
  })
  get(): HealthStatus {
    return this.health.status();
  }
}
