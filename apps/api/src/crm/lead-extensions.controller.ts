import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { LeadExtensionsService } from './lead-extensions.service';
import {
  CreateLeadStatusSchema,
  UpdateLeadStatusSchema,
  ChangeLeadStatusSchema,
  ListLeadStatusesQuerySchema,
  CreateLeadDocumentSchema,
  UpdateLeadDocumentSchema,
  CreateLeadFollowUpSchema,
  CompleteLeadFollowUpSchema,
  AdvancedFilterSchema,
} from './lead-extensions.dto';

/**
 * Lead Extensions Controller (C30).
 *
 * Exposes endpoints for lead statuses, documents, follow-ups,
 * advanced filtering, and WhatsApp conversation lookup.
 */
@Controller('crm')
@UseGuards(JwtAuthGuard)
export class LeadExtensionsController {
  constructor(private readonly service: LeadExtensionsService) {}

  // ───── Lead Statuses (Admin) ─────

  @Get('lead-statuses')
  async listStatuses(@Query() query: Record<string, string>) {
    const parsed = ListLeadStatusesQuerySchema.parse(query);
    return this.service.listStatuses(parsed.stageCode);
  }

  @Post('lead-statuses')
  async createStatus(@Body() body: unknown) {
    const dto = CreateLeadStatusSchema.parse(body);
    return this.service.createStatus(dto);
  }

  @Patch('lead-statuses/:id')
  async updateStatus(@Param('id') id: string, @Body() body: unknown) {
    const dto = UpdateLeadStatusSchema.parse(body);
    return this.service.updateStatus(id, dto);
  }

  @Delete('lead-statuses/:id')
  async deleteStatus(@Param('id') id: string) {
    await this.service.deleteStatus(id);
    return { success: true };
  }

  // ───── Lead Status Change ─────

  @Patch('leads/:id/status')
  async changeLeadStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
  ) {
    const dto = ChangeLeadStatusSchema.parse(body);
    return this.service.changeLeadStatus(id, dto.statusId, user.id);
  }

  // ───── Lead Documents ─────

  @Get('leads/:leadId/documents')
  async listDocuments(@Param('leadId') leadId: string) {
    return this.service.listDocuments(leadId);
  }

  @Post('leads/:leadId/documents')
  async createDocument(
    @Param('leadId') leadId: string,
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
  ) {
    const dto = CreateLeadDocumentSchema.parse(body);
    return this.service.createDocument(leadId, dto, user.id);
  }

  @Patch('leads/:leadId/documents/:docId')
  async updateDocument(
    @Param('leadId') leadId: string,
    @Param('docId') docId: string,
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
  ) {
    const dto = UpdateLeadDocumentSchema.parse(body);
    return this.service.updateDocument(leadId, docId, dto, user.id);
  }

  // ───── Lead Follow-ups ─────

  @Get('leads/:leadId/follow-ups')
  async listFollowUps(@Param('leadId') leadId: string) {
    return this.service.listFollowUps(leadId);
  }

  @Post('leads/:leadId/follow-ups')
  async createFollowUp(
    @Param('leadId') leadId: string,
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
  ) {
    const dto = CreateLeadFollowUpSchema.parse(body);
    return this.service.createFollowUp(leadId, dto, user.id);
  }

  @Patch('leads/:leadId/follow-ups/:followUpId/complete')
  async completeFollowUp(
    @Param('leadId') leadId: string,
    @Param('followUpId') followUpId: string,
    @Body() body: unknown,
    @CurrentUser() user: { id: string },
  ) {
    const dto = CompleteLeadFollowUpSchema.parse(body);
    return this.service.completeFollowUp(leadId, followUpId, dto, user.id);
  }

  @Get('follow-ups/mine')
  async listMyFollowUps(
    @CurrentUser() user: { id: string },
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.listMyFollowUps(user.id, status, limit ? parseInt(limit) : undefined);
  }

  @Get('follow-ups/due')
  async listDueFollowUps() {
    return this.service.listDueFollowUps();
  }

  // ───── Advanced Filter / Query Builder ─────

  @Post('leads/search')
  async advancedFilter(@Body() body: unknown) {
    const dto = AdvancedFilterSchema.parse(body);
    return this.service.advancedFilter(dto);
  }

  // ───── WhatsApp Conversation Lookup ─────

  @Get('leads/:leadId/conversations')
  async getLeadConversations(@Param('leadId') leadId: string) {
    return this.service.getLeadConversations(leadId);
  }
}
