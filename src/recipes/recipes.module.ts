import { Module } from '@nestjs/common';
import { RecipesGateway } from './recipes.gateway';
import { RecipesService } from './recipes.service';

@Module({
  providers: [RecipesService, RecipesGateway],
})
export class RecipesModule {}
