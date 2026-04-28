import { Global, Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { CompaniesService } from './companies.service';
import { CountriesService } from './countries.service';
import { TeamsService } from './teams.service';
import { AdminUsersService } from './admin-users.service';

/**
 * Org module (C12) — Companies / Countries / Teams + admin Users CRUD.
 *
 * Marked @Global so other modules (CRM, dashboards, distribution scopes
 * landing in later sprints) can pull these services in without redeclaring
 * them — same convention as RbacModule, UsersModule, CrmModule.
 */
@Global()
@Module({
  controllers: [OrgController],
  providers: [CompaniesService, CountriesService, TeamsService, AdminUsersService],
  exports: [CompaniesService, CountriesService, TeamsService, AdminUsersService],
})
export class OrgModule {}
