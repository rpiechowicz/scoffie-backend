import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { RecipesModule } from './recipes/recipes.module';
import { AuthModule } from './auth/auth.module';
import { HouseholdsModule } from './households/households.module';
import { WeeklyPlansModule } from './weekly-plans/weekly-plans.module';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    RecipesModule,
    AuthModule,
    HouseholdsModule,
    WeeklyPlansModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
