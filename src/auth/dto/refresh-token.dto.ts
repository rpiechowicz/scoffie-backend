import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  // Serwer wydaje 64 losowe bajty w hex (128 znaków); dłuższy ciąg to nie
  // jest nasz token i nie ma po co go haszować.
  @ApiProperty({ example: 'd3b07384d113edec49eaa6238ad5ff00...' })
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  refreshToken: string;
}
