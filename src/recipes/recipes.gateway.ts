import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';

class RecipesFindAllPayload {
  userId: string;
  householdId?: string;
  filters?: FindRecipesDto;
}

class RecipesFindByIdPayload {
  userId: string;
  id: string;
  householdId?: string;
}

class RecipesCreatePayload {
  userId: string;
  data: CreateRecipeDto;
}

class RecipesSetFavoritePayload {
  userId: string;
  data: UpdateRecipeFavoriteDto;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class RecipesGateway {
  constructor(private readonly recipesService: RecipesService) {}

  @SubscribeMessage('recipes:findAll')
  findAll(@MessageBody() payload: RecipesFindAllPayload) {
    return wsRespond(() => this.recipesService.findAll(payload.userId, payload.filters));
  }

  @SubscribeMessage('recipes:findById')
  findById(@MessageBody() payload: RecipesFindByIdPayload) {
    return wsRespond(() => this.recipesService.findById(payload.userId, payload.id, payload.householdId));
  }

  @SubscribeMessage('recipes:create')
  create(@MessageBody() payload: RecipesCreatePayload) {
    return wsRespond(() => this.recipesService.create(payload.userId, payload.data));
  }

  @SubscribeMessage('recipes:setFavorite')
  setFavorite(@MessageBody() payload: RecipesSetFavoritePayload) {
    return wsRespond(() => this.recipesService.setFavorite(payload.userId, payload.data));
  }
}
