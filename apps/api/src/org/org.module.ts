import { Global, Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { CompaniesService } from './companies.service';
import { CountriesService } from './countries.service';
import { TeamsService } from './teams.service';
import { AdminUsersService } from './admin-users.service';
import { UserScopeAssignmentsService } from './user-scope-assignments.service';

/**
 * Org module (C12) — Companies / Countries / Teams + admin Users CRUD.
 *
 * Marked @Global so other modules (CRM, dashboards, distribution scopes
 * landing in later sprints) can pull these services in without redeclaring
 * them — same convention as RbacModule, UsersModule, CrmModule.
 *
 * C9 adds `UserScopeAssignmentsService` for read + replace of the
 * per-user company / country bindings consumed by C3's scope resolver.
 */
@Global()
@Module({
  controllers: [OrgController],
  providers: [
    CompaniesService,
    CountriesService,
    TeamsService,
    AdminUsersService,
    UserScopeAssignmentsService,
  ],
  exports: [
    CompaniesService,
    CountriesService,
    TeamsService,
    AdminUsersService,
    UserScopeAssignmentsService,
  ],
})
export class OrgModule {}
