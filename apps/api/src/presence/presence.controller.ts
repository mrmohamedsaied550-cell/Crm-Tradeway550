import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { ActivitySchema, HeartbeatSchema, ListPresenceQuerySchema } from './presence.dto';
import { PresenceService } from './presence.service';

class HeartbeatBodyDto extends createZodDto(HeartbeatSchema) {}
class ActivityBodyDto extends createZodDto(ActivitySchema) {}
class ListPresenceQueryDto extends createZodDto(ListPresenceQuerySchema) {}

/**
 * /api/v1/presence — Sprint 10 (D10).
 *
 *   POST /presence/heartbeat — caller bumps lastSeenAt. Throttled
 *     server-side to one write per HEARTBEAT_WRITE_THROTTLE_MS.
 *
 *   POST /presence/activity  — caller bumps lastActiveAt + (optional)
 *     busyUntil. The Add Action drawer / Lead Detail open the user's
 *     "busy" window via this route.
 *
 *   GET  /presence/me        — caller's own presence (includes
 *     entity context).
 *
 *   GET  /presence/users     — bulk lookup by id list (cap 200).
 *     Out-of-scope users drop silently. Entity id is stripped from
 *     the response.
 *
 * Authentication: every route is JwtAuthGuard-gated. Heartbeat /
 * activity / me only need a valid JWT — the caller is talking
 * about themselves. The bulk users lookup requires `users.read`
 * to mirror the existing Organization People-table privilege.
 *
 * Tenant isolation is handled by `PrismaService.withTenant` inside
 * the service — every read flows through RLS.
 */
@ApiTags('presence')
@Controller('presence')
@UseGuards(JwtAuthGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Bump the caller's lastSeenAt. Throttled server-side; the bell + chip use the resulting row at read time.",
  })
  heartbeat(@Body() body: HeartbeatBodyDto, @CurrentUser() user: AccessTokenClaims) {
    return this.presence.heartbeat(user.sub, {
      context: body.context ?? null,
      entityType: body.entityType ?? null,
      entityId: body.entityId ?? null,
    });
  }

  @Post('activity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark the caller as active. Pass busy=true to enter the in-action window for a few minutes.',
  })
  activity(@Body() body: ActivityBodyDto, @CurrentUser() user: AccessTokenClaims) {
    return this.presence.activity(user.sub, {
      context: body.context ?? null,
      entityType: body.entityType ?? null,
      entityId: body.entityId ?? null,
      busy: body.busy,
    });
  }

  @Get('me')
  @ApiOperation({ summary: "The caller's own resolved presence." })
  me(@CurrentUser() user: AccessTokenClaims) {
    return this.presence.findOwn(user.sub);
  }

  @Get('users')
  @RequireCapability('users.read')
  @ApiOperation({
    summary:
      'Bulk presence lookup by user ids (cap 200). Tenant + RLS gate visibility; entity id is stripped from the response.',
  })
  async listForUsers(@Query() query: ListPresenceQueryDto) {
    const items = await this.presence.listForUsers(query.ids);
    return { items };
  }
}
