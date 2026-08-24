import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @ApiProperty({ example: 'invite-home-demo' })
  @IsString()
  @MinLength(8)
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
   */
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  leaveOtherHouseholds?: boolean;
}
