import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DataExportService } from './data-export.service';

/**
 * RODO art. 15/20 z telefonu: osoba pobiera swoją paczkę sama, bez pisania
 * do nas. Po HTTP z JWT (jak zgody), bo odpowiedź bywa duża — socket nie jest
 * do tego stworzony — a `Content-Disposition` pozwala iOS zapisać ją jako
 * plik do udostępnienia. Nic nie jest tu cache'owane: to dane osobowe.
 */
@ApiTags('data-export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/export')
export class DataExportController {
  constructor(private readonly dataExport: DataExportService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header(
    'Content-Disposition',
    'attachment; filename="weekly-meals-moje-dane.json"',
  )
  export(@CurrentUserId() userId: string) {
    return this.dataExport.exportFor(userId);
  }
}
