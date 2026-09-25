import { Module } from '@nestjs/common';
import { AdminCoreModule } from '../admin-core.module';
import { AdminDatabaseController } from './admin-database.controller';
import { AdminDatabaseService } from './admin-database.service';

/** Stan bazy (rozmiar, tabele, połączenia, migracje) dla ekranu „System”. */
@Module({
  imports: [AdminCoreModule],
  controllers: [AdminDatabaseController],
  providers: [AdminDatabaseService],
})
export class AdminDatabaseModule {}
