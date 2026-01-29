import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['google', 'apple'] })
  provider: string;

  @ApiProperty()
  providerId: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
