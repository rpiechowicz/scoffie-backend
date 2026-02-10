import { Module } from '@nestjs/common';
import { UsersGateway } from './users.gateway';
import { UsersService } from './users.service';

@Module({
  providers: [UsersService, UsersGateway],
})
export class UsersModule {}
