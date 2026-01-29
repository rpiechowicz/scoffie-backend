import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @ApiProperty({ example: 'invite-home-demo' })
  @IsString()
  @MinLength(8)
  token: string;

  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsString()
  userId: string;
}
