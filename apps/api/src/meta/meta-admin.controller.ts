/**
 * Sprint M2 / Phase 3 — admin Graph proxy endpoints.
 *
 *   GET /api/v1/meta/connections
 *     List active MetaOAuthConnections for the active tenant. Returns
 *     only safe summary fields (id, facebookUserId, facebookName,
 *     expiresAt, revokedAt). The encrypted accessToken is NEVER
 *     surfaced — Graph lookups happen server-side via
 *     MetaGraphService.
 *
 *   GET /api/v1/meta/pages?connectionId=...
 *     Proxies MetaGraphService.getPages for the new-integration
 *     modal's "pick a page" dropdown. Strips per-page access tokens
 *     from the response — those are server-side details only.
 *
 *   GET /api/v1/meta/forms?connectionId=...&pageId=...
 *     Proxies MetaGraphService.getLeadForms for the "pick a form"
 *     dropdown once the operator has chosen a page.
 *
 *   GET /api/v1/meta/form-questions?connectionId=...&formId=...
 *     Proxies MetaGraphService.getFormQuestions; feeds the
 *     FieldMappingUI's left column (one row per Meta question).
 *
 * All four are admin reads — the connection picker is part of the
 * setup flow, so `meta.leadsource.read` is the right capability.
 * The actual MetaLeadSource create/update lives on the existing
 * `/meta-lead-sources` surface (write-gated).
 */

import { Controller, Get, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';
import { requireTenantId } from '../tenants/tenant-context';
import { MetaGraphService } from './meta-graph.service';

const ConnectionIdQuerySchema = z.object({
  connectionId: z.string().uuid(),
});
class ConnectionIdQueryDto extends createZodDto(ConnectionIdQuerySchema) {}

const PageScopedQuerySchema = ConnectionIdQuerySchema.extend({
  pageId: z.string().trim().min(1).max(64),
});
class PageScopedQueryDto extends createZodDto(PageScopedQuerySchema) {}

const FormScopedQuerySchema = ConnectionIdQuerySchema.extend({
  formId: z.string().trim().min(1).max(64),
});
class FormScopedQueryDto extends createZodDto(FormScopedQuerySchema) {}

export interface ConnectionSummary {
  id: string;
  facebookUserId: string;
  facebookName: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

@ApiTags('crm')
@Controller('meta')
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class MetaAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphService,
  ) {}

  @Get('connections')
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'List Meta OAuth connections for the active tenant' })
  async listConnections(): Promise<ConnectionSummary[]> {
    const tenantId = requireTenantId();
    const rows = await this.prisma.metaOAuthConnection.findMany({
      where: { tenantId },
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        facebookUserId: true,
        facebookName: true,
        expiresAt: true,
        revokedAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      facebookUserId: r.facebookUserId,
      facebookName: r.facebookName,
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
      revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    }));
  }

  @Get('pages')
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'List Facebook Pages accessible to a connection' })
  async listPages(
    @Query() query: ConnectionIdQueryDto,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.assertConnectionInTenant(query.connectionId);
    const pages = await this.graph.getPages(query.connectionId);
    // Strip per-page access_tokens — never expose them to the client.
    return pages.map((p) => ({ id: p.id, name: p.name }));
  }

  @Get('forms')
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'List Lead Ads forms for a Page' })
  async listForms(
    @Query() query: PageScopedQueryDto,
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    await this.assertConnectionInTenant(query.connectionId);
    return this.graph.getLeadForms(query.connectionId, query.pageId);
  }

  @Get('form-questions')
  @RequireCapability('meta.leadsource.read')
  @ApiOperation({ summary: 'List the question schema for a Lead Ads form' })
  async listFormQuestions(
    @Query() query: FormScopedQueryDto,
  ): Promise<Array<{ key: string; label: string; type: string }>> {
    await this.assertConnectionInTenant(query.connectionId);
    return this.graph.getFormQuestions(query.connectionId, query.formId);
  }

  /**
   * Cross-tenant safety: every Graph lookup is keyed by connectionId,
   * which is a uuid (not guessable) but still has to belong to the
   * caller's tenant. Without this check a tenant-A admin could read
   * tenant-B's pages by guessing a uuid (or by replaying a uuid that
   * leaked into a log).
   */
  private async assertConnectionInTenant(connectionId: string): Promise<void> {
    const tenantId = requireTenantId();
    const row = await this.prisma.metaOAuthConnection.findFirst({
      where: { id: connectionId, tenantId },
      select: { id: true },
    });
    if (!row) {
      // Mirror the "not_found" code MetaGraphService raises so callers
      // can collapse the two on the client.
      throw new UnauthorizedException({
        code: 'meta.connection.not_found',
        message: `MetaOAuthConnection ${connectionId} not found in active tenant`,
      });
    }
  }
}
