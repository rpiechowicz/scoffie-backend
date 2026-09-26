import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  describeDatabasePool,
  readDatabasePoolSettings,
} from './database-config';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  async onModuleInit(): Promise<void> {
    // Efektywne parametry puli jawnie w logu startu (Etap 4D) — bez adresu.
    const settings = readDatabasePoolSettings();
    const logger = new Logger(PrismaService.name);
    const line = `pula Prisma: ${describeDatabasePool(settings)}`;
    if (settings.invalid.length > 0) logger.warn(line);
    else logger.log(line);
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
