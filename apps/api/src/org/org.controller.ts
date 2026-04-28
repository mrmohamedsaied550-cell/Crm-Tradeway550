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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { JwtAuthGuard } from '../identity/jwt-auth.guard';

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
  UpdateCompanySchema,
  UpdateCountrySchema,
  UpdateTeamSchema,
  UpdateUserSchema,
} from './org.dto';

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
@UseGuards(JwtAuthGuard)
export class OrgController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly countries: CountriesService,
    private readonly teams: TeamsService,
    private readonly users: AdminUsersService,
  ) {}

  // ───────── Companies ─────────

  @Get('companies')
  @ApiOperation({ summary: 'List companies in the active tenant' })
  listCompanies() {
    return this.companies.list();
  }

  @Get('companies/:id')
  @ApiOperation({ summary: 'Get a company by id' })
  getCompany(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.findByIdOrThrow(id);
  }

  @Post('companies')
  @ApiOperation({ summary: 'Create a company' })
  createCompany(@Body() body: CreateCompanyDto) {
    return this.companies.create(body);
  }

  @Patch('companies/:id')
  @ApiOperation({ summary: 'Update a company' })
  updateCompany(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCompanyDto) {
    return this.companies.update(id, body);
  }

  @Delete('companies/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a company (rejected if it has countries)' })
  async deleteCompany(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.companies.delete(id);
  }

  // ───────── Countries ─────────

  @Get('countries')
  @ApiOperation({ summary: 'List countries (optional filter by companyId)' })
  listCountries(@Query() query: ListCountriesQueryDto) {
    return this.countries.list(query);
  }

  @Get('countries/:id')
  @ApiOperation({ summary: 'Get a country by id' })
  getCountry(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.countries.findByIdOrThrow(id);
  }

  @Post('countries')
  @ApiOperation({ summary: 'Create a country under a company' })
  createCountry(@Body() body: CreateCountryDto) {
    return this.countries.create(body);
  }

  @Patch('countries/:id')
  @ApiOperation({ summary: 'Update a country' })
  updateCountry(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCountryDto) {
    return this.countries.update(id, body);
  }

  @Delete('countries/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a country (rejected if it has teams)' })
  async deleteCountry(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.countries.delete(id);
  }

  // ───────── Teams ─────────

  @Get('teams')
  @ApiOperation({ summary: 'List teams (optional filter by countryId)' })
  listTeams(@Query() query: ListTeamsQueryDto) {
    return this.teams.list(query);
  }

  @Get('teams/:id')
  @ApiOperation({ summary: 'Get a team by id' })
  getTeam(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.teams.findByIdOrThrow(id);
  }

  @Post('teams')
  @ApiOperation({ summary: 'Create a team under a country' })
  createTeam(@Body() body: CreateTeamDto) {
    return this.teams.create(body);
  }

  @Patch('teams/:id')
  @ApiOperation({ summary: 'Update a team' })
  updateTeam(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateTeamDto) {
    return this.teams.update(id, body);
  }

  @Delete('teams/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a team (users are detached, not deleted)' })
  async deleteTeam(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.teams.delete(id);
  }

  // ───────── Admin Users ─────────

  @Get('users')
  @ApiOperation({ summary: 'List users with filters + pagination' })
  listUsers(@Query() query: ListUsersQueryDto) {
    return this.users.list(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get a user by id' })
  getUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.findByIdOrThrow(id);
  }

  @Post('users')
  @ApiOperation({ summary: 'Create a user (admin invite path)' })
  createUser(@Body() body: CreateUserDto) {
    return this.users.create(body);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Update user role / team / status / profile' })
  updateUser(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateUserDto) {
    return this.users.update(id, body);
  }

  @Post('users/:id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a user (soft-deactivate)' })
  disableUser(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.disable(id);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Hard-delete a user' })
  async deleteUser(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    await this.users.delete(id);
  }
}
