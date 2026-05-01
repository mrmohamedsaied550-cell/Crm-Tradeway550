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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';

import { CurrentUser } from '../identity/current-user.decorator';
import { JwtAuthGuard } from '../identity/jwt-auth.guard';
import type { AccessTokenClaims } from '../identity/jwt.types';

import { CompetitionsService } from './competitions.service';
import {
  CreateCompetitionSchema,
  SetCompetitionStatusSchema,
  UpdateCompetitionSchema,
} from './competition.dto';

class CreateCompetitionDto extends createZodDto(CreateCompetitionSchema) {}
class UpdateCompetitionDto extends createZodDto(UpdateCompetitionSchema) {}
class SetCompetitionStatusDto extends createZodDto(SetCompetitionStatusSchema) {}

@ApiTags('competitions')
@Controller('competitions')
@UseGuards(JwtAuthGuard)
export class CompetitionsController {
  constructor(private readonly competitions: CompetitionsService) {}

  @Get()
  @ApiOperation({ summary: 'List competitions in the active tenant' })
  list() {
    return this.competitions.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one competition' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.competitions.findByIdOrThrow(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a competition' })
  create(@Body() body: CreateCompetitionDto, @CurrentUser() user: AccessTokenClaims) {
    return this.competitions.create(body, user.sub);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a competition' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateCompetitionDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.competitions.update(id, body, user.sub);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set competition status (draft / active / closed)' })
  setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: SetCompetitionStatusDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return this.competitions.setStatus(id, body.status, user.sub);
  }

  @Get(':id/leaderboard')
  @ApiOperation({ summary: 'Best-effort leaderboard for the competition window' })
  leaderboard(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.competitions.leaderboard(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a competition' })
  remove(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AccessTokenClaims,
  ): Promise<void> {
    return this.competitions.remove(id, user.sub);
  }
}
