import {
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

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
export class RecipesGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly recipesService: RecipesService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(RecipesGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(RecipesGateway.name);
  }

  @SubscribeMessage('recipes:findAll')
  findAll(@MessageBody() payload: RecipesFindAllPayload) {
    return wsRespond(() =>
      this.recipesService.findAll(payload.userId, payload.filters),
    );
  }

  @SubscribeMessage('recipes:findById')
  findById(@MessageBody() payload: RecipesFindByIdPayload) {
    return wsRespond(() =>
      this.recipesService.findById(
        payload.userId,
        payload.id,
        payload.householdId,
      ),
    );
  }

  @SubscribeMessage('recipes:create')
  create(@MessageBody() payload: RecipesCreatePayload) {
    return wsRespond(() =>
      this.recipesService.create(payload.userId, payload.data),
    );
  }

  @SubscribeMessage('recipes:setFavorite')
  setFavorite(@MessageBody() payload: RecipesSetFavoritePayload) {
    return wsRespond(async () => {
      const result = await this.recipesService.setFavorite(
        payload.userId,
        payload.data,
      );
      this.server.emit('recipes:favoritesChanged', {
        householdId: payload.data.householdId,
        recipeId: payload.data.recipeId,
        isFavorite: payload.data.isFavorite,
        changedByUserId: payload.userId,
      });
      return result;
    });
  }
}
