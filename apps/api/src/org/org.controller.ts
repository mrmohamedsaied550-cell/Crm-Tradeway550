import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';
import { CapabilityGuard } from '../rbac/capability.guard';
import { RequireCapability } from '../rbac/require-capability.decorator';

import { CompaniesService } from './companies.service';
import { CountriesService } from './countries.service';
import { TeamsService } from './teams.service';
import { AdminUsersService } from './admin-users.service';
import {
  CreateCompanySchema,
  CreateCountrySchema,
  CreateTeamSchema,
  CreateUserSchema,
  ListCountriesQuerySchema,
  ListTeamsQuerySchema,
  ListUsersQuerySchema,
  PutUserScopeAssignmentsSchema,
  SetUserRoleSchema,
  SetUserStatusSchema,
  SetUserTeamSchema,
  UpdateCompanySchema,
  UpdateCountrySchema,
  UpdateTeamSchema,
  UpdateUserSchema,
} from './org.dto';
import { UserScopeAssignmentsService } from './user-scope-assignments.service';

class CreateCompanyDto extends createZodDto(CreateCompanySchema) {}
class UpdateCompanyDto extends createZodDto(UpdateCompanySchema) {}
class CreateCountryDto extends createZodDto(CreateCountrySchema) {}
class UpdateCountryDto extends createZodDto(UpdateCountrySchema) {}
class ListCountriesQueryDto extends createZodDto(ListCountriesQuerySchema) {}
class CreateTeamDto extends createZodDto(CreateTeamSchema) {}
class UpdateTeamDto extends createZodDto(UpdateTeamSchema) {}
class ListTeamsQueryDto extends createZodDto(ListTeamsQuerySchema) {}
class CreateUserDto extends createZodDto(CreateUserSchema) {}
class UpdateUserDto extends createZodDto(UpdateUserSchema) {}
class ListUsersQueryDto extends createZodDto(ListUsersQuerySchema) {}
class SetUserRoleDto extends createZodDto(SetUserRoleSchema) {}
class SetUserTeamDto extends createZodDto(SetUserTeamSchema) {}
class SetUserStatusDto extends createZodDto(SetUserStatusSchema) {}
class PutUserScopeAssignmentsDto extends createZodDto(PutUserScopeAssignmentsSchema) {}

/**
 * /api/v1 — org-structure admin surface (C12).
 *
 * Single controller groups Companies / Countries / Teams / Users since
 * they all live behind the same JwtAuthGuard and share the org concern.
 * Capability-based authorization (org.company.write, etc.) is wired up
 * by the future @Capability() guard mentioned in JwtAuthGuard's docstring;
 * for C12 we keep the contract intact and rely on JWT auth + RLS for
 * isolation.
 */
@ApiTags('org')
@Controller()
@UseGuards(JwtAuthGuard, CapabilityGuard)
export class OrgController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly countries: CountriesService,
    private readonly teams: TeamsService,
    private readonly users: AdminUsersService,
    private readonly userScopes: UserScopeAssignmentsService,
  ) {}

  // ───────── Companies ─────────

  @Get('companies')
  @RequireCapability('org.company.read')
  @ApiOperation({ summary: 'List companies in the active tenant' })
  listCompanies() {
    return this.companies.list();
  }

  @Get('companies/:id')
  @RequireCapability('org.company.read')
  @ApiOperation({ summary: 'Get a company by id' })
  getCompany(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.findByIdOrThrow(id);
  }

  @Post('companies')
  @RequireCapability('org.company.write')
  @ApiOperation({ summary: 'Create a company' })
  createCompany(@Body() body: CreateCompanyDto) {
    return this.companies.create(body);
  }

  @Patch('companies/:id')
  @RequireCapability('org.company.write')
  @ApiOperation({ summary: 'Update a company' })
  updateCompany(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCompanyDto) {
    return this.companies.update(id, body);
  }

  @Delete('companies/:id')
  @RequireCapability('org.company.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a company (rejected if it has countries)' })
  async deleteCompany(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.companies.delete(id);
  }

  // ───────── Countries ─────────

  @Get('countries')
  @RequireCapability('org.country.read')
  @ApiOperation({ summary: 'List countries (optional filter by companyId)' })
  listCountries(@Query() query: ListCountriesQueryDto) {
    return this.countries.list(query);
  }

  @Get('countries/:id')
  @RequireCapability('org.country.read')
  @ApiOperation({ summary: 'Get a country by id' })
  getCountry(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.countries.findByIdOrThrow(id);
  }

  @Post('countries')
  @RequireCapability('org.country.write')
  @ApiOperation({ summary: 'Create a country under a company' })
  createCountry(@Body() body: CreateCountryDto) {
    return this.countries.create(body);
  }

  @Patch('countries/:id')
  @RequireCapability('org.country.write')
  @ApiOperation({ summary: 'Update a country' })
  updateCountry(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCountryDto) {
    return this.countries.update(id, body);
  }

  @Delete('countries/:id')
  @RequireCapability('org.country.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a country (rejected if it has teams)' })
  async deleteCountry(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.countries.delete(id);
  }

  // ───────── Teams ─────────

  @Get('teams')
  @RequireCapability('org.team.read')
  @ApiOperation({ summary: 'List teams (optional filter by countryId)' })
  listTeams(@Query() query: ListTeamsQueryDto) {
    return this.teams.list(query);
  }

  @Get('teams/:id')
  @RequireCapability('org.team.read')
  @ApiOperation({ summary: 'Get a team by id' })
  getTeam(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.teams.findByIdOrThrow(id);
  }

  @Post('teams')
  @RequireCapability('org.team.write')
  @ApiOperation({ summary: 'Create a team under a country' })
  createTeam(@Body() body: CreateTeamDto) {
    return this.teams.create(body);
  }

  @Patch('teams/:id')
  @RequireCapability('org.team.write')
  @ApiOperation({ summary: 'Update a team' })
  updateTeam(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateTeamDto) {
    return this.teams.update(id, body);
  }

  @Delete('teams/:id')
  @RequireCapability('org.team.write')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team (users are detached, not deleted)' })
  async deleteTeam(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.teams.delete(id);
  }

  // ───────── Admin Users ─────────

  @Get('users')
  @RequireCapability('users.read')
  @ApiOperation({ summary: 'List users with filters + pagination' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get('users/:id')
  @RequireCapability('users.read')
  @ApiOperation({ summary: 'Get a user by id' })
  getUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.findByIdOrThrow(id);
  }

  @Post('users')
  @RequireCapability('users.write')
  @ApiOperation({ summary: 'Create a user (admin invite path)' })
  createUser(@Body() body: CreateUserDto) {
    return this.users.create(body);
  }

  @Patch('users/:id')
  @RequireCapability('users.write')
  @ApiOperation({ summary: 'Update user role / team / status / profile' })
  updateUser(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateUserDto) {
    return this.users.update(id, body);
  }

  @Post('users/:id/enable')
  @RequireCapability('users.disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a user (status → active). Idempotent.' })
  enableUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.enable(id);
  }

  @Post('users/:id/disable')
  @RequireCapability('users.disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a user (status → disabled). Idempotent.' })
  disableUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.disable(id);
  }

  @Patch('users/:id/role')
  @RequireCapability('users.write')
  @ApiOperation({ summary: 'Set the user role; rejects role IDs from another tenant' })
  setUserRole(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: SetUserRoleDto) {
    return this.users.setRole(id, body.roleId);
  }

  @Patch('users/:id/team')
  @RequireCapability('users.write')
  @ApiOperation({
    summary:
      'Set or clear the user team; pass `null` to detach. Rejects team IDs from another tenant.',
  })
  setUserTeam(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: SetUserTeamDto) {
    return this.users.setTeam(id, body.teamId);
  }

  @Patch('users/:id/status')
  @RequireCapability('users.disable')
  @ApiOperation({ summary: 'Set the user status (active / invited / disabled).' })
  setUserStatus(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: SetUserStatusDto) {
    return this.users.setStatus(id, body.status);
  }

  @Delete('users/:id')
  @RequireCapability('users.disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Hard-delete a user' })
  async deleteUser(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.users.delete(id);
  }

  // ───────── User scope assignments (C9) ─────────

  @Get('users/:id/scope-assignments')
  @RequireCapability('users.read')
  @ApiOperation({
    summary: 'List the company / country bindings consumed by company / country scope',
  })
  listUserScopeAssignments(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.userScopes.listForUser(id);
  }

  @Put('users/:id/scope-assignments')
  @RequireCapability('users.write')
  @ApiOperation({
    summary:
      'Replace the user company / country bindings (full set). Validates each id belongs to the active tenant; emits user.scope.update + assign / revoke audit events.',
  })
  putUserScopeAssignments(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: PutUserScopeAssignmentsDto,
    @CurrentUser() actor: AccessTokenClaims,
  ) {
    return this.userScopes.replaceForUser(id, body, actor.sub);
  }
}
