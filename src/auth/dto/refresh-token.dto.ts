import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ example: 'd3b07384d113edec49eaa6238ad5ff00...' })
  @IsString()
  @MinLength(32)
  refreshToken: string;
}
