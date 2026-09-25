import { Module } from '@nestjs/common';
import { FxRateService } from './fx-rate.service';

/**
 * Kurs NBP dla ekranów panelu (Wypłaty z Apple, Asystent, raport dzienny).
 * Jeden `FxRateService` na proces — pętla pobierania chodzi raz, niezależnie
 * od tego, ile modułów importuje ten.
 */
@Module({
  providers: [FxRateService],
  exports: [FxRateService],
})
export class AdminFxModule {}
