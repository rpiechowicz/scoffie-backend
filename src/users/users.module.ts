import { Module } from '@nestjs/common';
import { UsersGateway } from './users.gateway';
import { AppleRevocationService } from './apple-revocation.service';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, UsersGateway, AppleRevocationService],
})
export class UsersModule {}
