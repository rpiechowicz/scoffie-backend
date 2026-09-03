import { Module } from '@nestjs/common';
import { ConsentsModule } from '../consents/consents.module';
import { UsersGateway } from './users.gateway';
import { AppleRevocationService } from './apple-revocation.service';
import { UsersService } from './users.service';

@Module({
  imports: [ConsentsModule],
  providers: [UsersService, UsersGateway, AppleRevocationService],
})
export class UsersModule {}
