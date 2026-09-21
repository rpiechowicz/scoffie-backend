import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AcceptInvitationDto {
  /**
   * Token z linku (32 hex z `randomBytes(16)`) ALBO uchwyt skrzynki
   * `inv_<id zaproszenia>` z `households:listPendingInvitations` — ten drugi
   * działa tylko dla adresata. `MaxLength` odcina śmieci, nie prawdziwe tokeny.
   */
  @ApiProperty({ example: 'invite-home-demo', minLength: 8, maxLength: 128 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  token: string;

  /**
   * Zgoda na opuszczenie dotychczasowego gospodarstwa.
   *
   * Bez niej przyjęcie zaproszenia przez kogoś, kto już gdzieś należy, kończy
   * się `INVITATION_REQUIRES_LEAVE` — bo jedno konto obsługuje jedno
   * gospodarstwo (`buildAuthResult` bierze jedno członkostwo, a cała aplikacja
   * czyta `currentHouseholdId`), więc ciche dopisanie drugiego dawało
   * użytkownikowi członkostwo, którego nigdzie nie widział. Wyjście z domu to
   * utrata dostępu do wspólnego planu i listy zakupów, więc musi być
   * potwierdzone jawnie, a nie wywnioskowane.
   *
   * Wyłącznie prawdziwy boolean: napis `'false'` był na WS truthy i liczył się
   * jako zgoda na opuszczenie domu.
   */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  leaveOtherHouseholds?: boolean;
}
