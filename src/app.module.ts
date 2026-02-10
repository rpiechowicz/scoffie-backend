import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { RecipesModule } from './recipes/recipes.module';
import { HouseholdsModule } from './households/households.module';
import { WeeklyPlansModule } from './weekly-plans/weekly-plans.module';

@Module({
  imports: [
    PrismaModule,
    UsersModule,
    RecipesModule,
    HouseholdsModule,
    WeeklyPlansModule,
  ],
})
export class AppModule {}
