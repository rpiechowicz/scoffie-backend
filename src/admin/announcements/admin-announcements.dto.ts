import {
  ArrayMaxSize,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  ANNOUNCEMENT_AUDIENCES,
  ANNOUNCEMENT_SEVERITIES,
} from '../../announcements/announcements.rules';
import type {
  AnnouncementAudience,
  AnnouncementCreate,
  AnnouncementSeverity,
} from '../contract';

/**
 * `POST /admin/announcements`. Długości sprawdza tu tylko zgrubnie (bajty
 * UTF-16); właściwe limity (80/400 znaków, czysty tekst, 3 naraz) liczy
 * serwis — tam, gdzie widać też zakres dat i pozostałe komunikaty.
 */
export class AdminAnnouncementCreateDto implements AnnouncementCreate {
  @IsString()
  @MaxLength(400)
  title!: string;

  @IsString()
  @MaxLength(2000)
  body!: string;

  @IsIn(ANNOUNCEMENT_SEVERITIES)
  severity!: AnnouncementSeverity;

  @IsIn(ANNOUNCEMENT_AUDIENCES)
  audience!: AnnouncementAudience;

  @IsOptional()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  householdIds?: string[];

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  @IsBoolean()
  dismissible!: boolean;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
