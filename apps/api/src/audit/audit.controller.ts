import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { ResourceFieldGate } from '../rbac/resource-field-gate.decorator';
import { AuditService } from './audit.service';
import {
  AUDIT_ACTION_GROUPS,
  listActionPrefixCodes,
  resolveActionPrefixes,
} from './audit-action-groups';

@ApiTags('audit')
@Controller('audit')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequireCapability('audit.read')
  @ResourceFieldGate('audit')
  @ApiOperation({
    summary: 'Unified audit stream (audit_events + lead_activities), newest first',
    description:
      'Optional `action` query: exact verb (e.g. "auth.login.success") or ' +
      'prefix wildcard (e.g. "auth.*"). The wildcard form is what the admin ' +
      'audit screen uses to surface every auth-related event in one click. ' +
      'D5.11 — `actionPrefix` query: allow-listed governance group code ' +
      '(rbac / role / user_scope / tenant_export / report_export / ' +
      'partner_recon_export / partner_commission_export / export_governance). ' +
      'Unknown codes are rejected with `audit.action_prefix.unknown`. ' +
      '`entityId` narrows to one specific audit_event row (drops the ' +
      'lead_activities half of the stream).',
  })
  list(
    @CurrentUser() user: AccessTokenClaims,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('action') action?: string,
    @Query('actionPrefix') actionPrefix?: string,
    @Query('entityId') entityId?: string,
  ) {
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const beforeDate = before ? new Date(before) : undefined;
    const trimmedAction = action?.trim();
    const trimmedEntityId = entityId?.trim();
    const trimmedPrefix = actionPrefix?.trim();
    let actionPrefixes: readonly string[] | undefined;
    if (trimmedPrefix && trimmedPrefix.length > 0) {
      const resolved = resolveActionPrefixes(trimmedPrefix);
      if (!resolved) {
        throw new BadRequestException({
          code: 'audit.action_prefix.unknown',
          message: `Unknown actionPrefix '${trimmedPrefix}'. Allowed codes: ${listActionPrefixCodes().join(', ')}`,
          allowedCodes: listActionPrefixCodes(),
        });
      }
      actionPrefixes = resolved;
    }
    return this.audit.list({
      limit: lim && Number.isFinite(lim) ? lim : undefined,
      before: beforeDate && !Number.isNaN(beforeDate.getTime()) ? beforeDate : undefined,
      ...(trimmedAction && trimmedAction.length > 0 && { action: trimmedAction }),
      ...(actionPrefixes && { actionPrefixes }),
      ...(trimmedEntityId && trimmedEntityId.length > 0 && { entityId: trimmedEntityId }),
      // D5.12-B — pass the caller's claims so the WhatsApp
      // handover-payload redactor can resolve their
      // `whatsapp.conversation` field-permission deny list.
      userClaims: { userId: user.sub, tenantId: user.tid, roleId: user.rid },
    });
  }

  /**
   * D5.11 — return the allow-listed action-prefix groups so the
   * admin audit chips render against the same source of truth the
   * server enforces. The chip strip ships codes; this endpoint
   * tells the client which codes are valid + which prefixes each
   * code expands to (the latter is informational; the server still
   * validates the code on every list call).
   */
  @Get('action-groups')
  @RequireCapability('audit.read')
  @ApiOperation({
    summary: 'List the allow-listed action-prefix groups for the audit chip strip',
  })
  listActionGroups(): { groups: readonly { code: string; actionPrefixes: readonly string[] }[] } {
    return {
      groups: AUDIT_ACTION_GROUPS.map((g) => ({
        code: g.code,
        actionPrefixes: g.actionPrefixes,
      })),
    };
  }
}
