import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const membershipRoles = ['OWNER', 'MEMBER'] as const;

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: membershipRoles })
  @IsIn(membershipRoles)
  role: (typeof membershipRoles)[number];
}
