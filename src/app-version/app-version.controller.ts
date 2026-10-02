import { Controller, Get, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { appVersionStatus, type AppVersionStatus } from '../config/app-version';
import { AppVersionQueryDto } from './app-version.dto';

/**
 * Czy ta wersja aplikacji może jeszcze działać — patrz `config/app-version.ts`.
 *
 * BEZ logowania (ekran „Zaktualizuj” ma zadziałać także przed logowaniem
 * i przy zepsutej sesji) i BEZ limitu żądań: odpowiedź to odczyt z pamięci
 * procesu, a cały dom za jednym IP operatora (CGNAT) z limitem per IP
 * dostałby 429 — telefon przepuszcza wtedy po cichu, więc limit niczego by
 * nie chronił, a tylko psuł wyłącznik. KONTRAKT NA ZAWSZE: najstarszy build
 * pyta tym samym adresem i czyta te same pola — nie zmieniać kształtu.
 */
@Controller('public/app-version')
@SkipThrottle({ default: true, ip: true })
export class AppVersionController {
  @Get()
  status(
    @Query() query: AppVersionQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): AppVersionStatus {
    // Krótko: podniesiony próg ma dojść do telefonów w minutę.
    res.setHeader('Cache-Control', 'public, max-age=60');
    return appVersionStatus(query.platform, query.version);
  }
}
