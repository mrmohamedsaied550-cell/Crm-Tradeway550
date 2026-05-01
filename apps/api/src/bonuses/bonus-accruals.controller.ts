import {
  Body,
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
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { BonusAccrualsService, type AccrualStatus } from './bonus-accruals.service';

const STATUSES = new Set<AccrualStatus>(['pending', 'paid', 'void']);

/**
 * /api/v1/bonus-accruals (P2-03) — read + status-transition surface
 * for the bonus accruals written by `BonusEngine.onActivationInTx`.
 *
 * `mine` is open to anyone authenticated with `bonus.read` so an
 * agent can see their own pipeline; tenant-wide list + setStatus
 * require the admin `bonus.write` capability.
 */
@ApiTags('bonuses')
@Controller('bonus-accruals')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class BonusAccrualsController {
  constructor(private readonly accruals: BonusAccrualsService) {}

  @Get('mine')
  @RequireCapability('bonus.read')
  @ApiOperation({ summary: "Calling user's bonus accruals (newest first)" })
  mine(@Query('status') status: string | undefined, @CurrentUser() user: AccessTokenClaims) {
    const s = isStatus(status) ? status : undefined;
    return this.accruals.listMine(user.sub, { status: s });
  }

  @Get()
  @RequireCapability('bonus.write')
  @ApiOperation({ summary: 'List bonus accruals across the tenant' })
  list(
    @Query('status') status: string | undefined,
    @Query('recipientUserId') recipientUserId: string | undefined,
  ) {
    const s = isStatus(status) ? status : undefined;
    return this.accruals.list({ status: s, recipientUserId });
  }

  @Post(':id/status')
  @RequireCapability('bonus.write')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark accrual paid / void / pending' })
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: { status: AccrualStatus },
    @CurrentUser() user: AccessTokenClaims,
  ) {
    if (!isStatus(body.status)) {
      // The body shape is validated by the controller-level zod
      // pipe at the global level — fall through here if a misuse
      // somehow reaches us. Throwing UnsupportedMediaType-ish would
      // be wrong; let the runtime check stop it cleanly.
      throw new Error(`invalid_status:${String(body.status)}`);
    }
    return this.accruals.setStatus(id, body.status, user.sub);
  }
}

function isStatus(v: unknown): v is AccrualStatus {
  return typeof v === 'string' && STATUSES.has(v as AccrualStatus);
}
