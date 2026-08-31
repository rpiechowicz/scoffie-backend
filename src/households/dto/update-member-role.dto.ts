import { ApiProperty } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

/**
 * Rola z enumu Prismy, nie z lokalnej kopii — jedno źródło prawdy, a komunikat
 * błędu niesie listę dozwolonych (`role must be one of the following values:
 * OWNER, MEMBER`), z której korzysta i klient, i asystent.
 */
export class UpdateMemberRoleDto {
  @ApiProperty({ enum: MembershipRole, enumName: 'MembershipRole' })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}
