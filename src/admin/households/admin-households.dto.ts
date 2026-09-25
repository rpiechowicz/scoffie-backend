import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Powód akcji panelu — trafia do `AdminAuditLog.reason` (ROADMAPA §1.2).
 * Globalny `ValidationPipe` ma `forbidNonWhitelisted`, więc pole bez
 * dekoratora to 400, a nie cicho zignorowany śmieć.
 */
export class AdminReasonDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

/**
 * Nadanie / zdjęcie PRO. `/ops` przyjmuje jeszcze `TRIAL`, ale panel wysyła
 * wyłącznie `PRO` albo `null` — i tylko to przechodzi. Pole jest WYMAGANE:
 * brak `tier` to 400, a nie ciche „zdejmij nadanie" (tak czytało je `/ops`
 * przez `body?.tier ?? null`), bo akcja, która boli, ma być jawna.
 */
export class AdminSetTierDto extends AdminReasonDto {
  @IsIn(['PRO', null], { message: 'tier musi być "PRO" albo null' })
  tier!: 'PRO' | null;
}
