import { ApiProperty } from '@nestjs/swagger';

export class UserDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  googleId: string;

  @ApiProperty()
  displayName: string;

  @ApiProperty({ required: false, nullable: true })
  email?: string | null;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
