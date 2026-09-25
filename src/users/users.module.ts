import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { MailModule } from '../mail/mail.module';
import { UsersGateway } from './users.gateway';
import { AppleRevocationService } from './apple-revocation.service';
import { UsersService } from './users.service';

@Module({
  imports: [ConsentsModule, MailModule],
  providers: [UsersService, UsersGateway, AppleRevocationService],
  // Panel administratora kasuje konto TĄ SAMĄ ścieżką co telefon.
  exports: [UsersService],
})
export class UsersModule {}
