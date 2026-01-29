import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @ApiProperty({ example: 'invite-home-demo' })
  @IsString()
  @MinLength(8)
  token: string;
}
