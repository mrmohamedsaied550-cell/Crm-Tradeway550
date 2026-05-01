import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { NotificationsService } from './notifications.service';

/**
 * /api/v1/notifications (P2-02) — calling-user inbox.
 *
 * Intentionally NOT capability-gated: any authenticated user can read
 * their own notifications. The service enforces "you can only see
 * your own" by filtering on recipient_user_id = JWT.sub.
 */
@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'List the calling user notifications (unread first)' })
  list(
    @Query('unread') unread: string | undefined,
    @Query('limit') limit: string | undefined,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    return this.notifications.list(user.sub, {
      unreadOnly: unread === '1' || unread === 'true',
      limit: lim && Number.isFinite(lim) ? lim : undefined,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications for the calling user' })
  async unreadCount(@CurrentUser() user: AccessTokenClaims): Promise<{ count: number }> {
    const count = await this.notifications.unreadCount(user.sub);
    return { count };
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AccessTokenClaims) {
    return this.notifications.markRead(id, user.sub);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark every unread notification for the calling user as read' })
  markAllRead(@CurrentUser() user: AccessTokenClaims) {
    return this.notifications.markAllRead(user.sub);
  }
}
