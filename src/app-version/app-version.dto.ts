import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { APP_PLATFORMS, type AppPlatform } from '../config/app-version';

export class AppVersionQueryDto {
  @ApiProperty({ enum: APP_PLATFORMS, example: 'ios' })
  @IsIn(APP_PLATFORMS)
  platform!: AppPlatform;

  /**
   * Wersja aplikacji (`CFBundleShortVersionString` / `versionName`), np. `1.0.2`.
   * Brak albo nieczytelna = serwer nie blokuje.
   */
  @ApiPropertyOptional({ example: '1.0.2' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;
}
