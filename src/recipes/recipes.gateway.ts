import { MessageBody, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';

class RecipesFindAllPayload {
  userId: string;
  householdId?: string;
}

class RecipesFindByIdPayload {
  userId: string;
  id: string;
}

class RecipesCreatePayload {
  userId: string;
  data: CreateRecipeDto;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class RecipesGateway {
  constructor(private readonly recipesService: RecipesService) {}

  @SubscribeMessage('recipes:findAll')
  findAll(@MessageBody() payload: RecipesFindAllPayload) {
    return wsRespond(() => this.recipesService.findAll(payload.userId, payload.householdId));
  }

  @SubscribeMessage('recipes:findById')
  findById(@MessageBody() payload: RecipesFindByIdPayload) {
    return wsRespond(() => this.recipesService.findById(payload.userId, payload.id));
  }

  @SubscribeMessage('recipes:create')
  create(@MessageBody() payload: RecipesCreatePayload) {
    return wsRespond(() => this.recipesService.create(payload.userId, payload.data));
  }
}
