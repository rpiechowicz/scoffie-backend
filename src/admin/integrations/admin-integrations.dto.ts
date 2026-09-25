import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { MailFilters, MailStatus, MailTemplate } from '../contract';
import { MAIL_TEMPLATE_IDS } from '../../mail/mail-template';

const STATUSES: MailStatus[] = [
  'QUEUED',
  'SENDING',
  'SENT',
  'FAILED',
  'SKIPPED',
];

/** `GET /admin/mail` — nazwy pól 1:1 z `MailFilters` kontraktu. */
export class AdminMailQueryDto implements MailFilters {
  @IsOptional()
  @IsIn(STATUSES)
  status?: MailStatus;

  @IsOptional()
  @IsIn([...MAIL_TEMPLATE_IDS])
  template?: MailTemplate;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

/** `POST /admin/mail/suppressions` */
export class AdminSuppressDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
