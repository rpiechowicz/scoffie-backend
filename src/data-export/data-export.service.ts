import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { buildUserExport } from './user-export';

@Injectable()
export class DataExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportFor(userId: string) {
    const bundle = await buildUserExport(this.prisma, userId);
    if (!bundle) {
      throw new AppException(
        'NOT_FOUND',
        'Konto nie istnieje.',
        HttpStatus.NOT_FOUND,
      );
    }
    return bundle;
  }
}
