import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { actorId } from '../common/ws-socket';
import type { AppSocket } from '../common/ws-socket';
import { broadcastToHousehold } from '../common/ws-rooms';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

class RecipesFindAllPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  householdId?: string;
  filters?: FindRecipesDto;
}

class RecipesFindByIdPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  id: string;
  householdId?: string;
}

class RecipesCreatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
  data: CreateRecipeDto;
}

class RecipesSetFavoritePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  userId?: string;
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
  findAll(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesFindAllPayload,
  ) {
    return wsRespond(() =>
      this.recipesService.findAll(actorId(client, payload), payload.filters),
    );
  }

  @SubscribeMessage('recipes:findById')
  findById(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesFindByIdPayload,
  ) {
    return wsRespond(() =>
      this.recipesService.findById(
        actorId(client, payload),
        payload.id,
        payload.householdId,
      ),
    );
  }

  @SubscribeMessage('recipes:create')
  create(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesCreatePayload,
  ) {
    return wsRespond(() =>
      this.recipesService.create(actorId(client, payload), payload.data),
    );
  }

  @SubscribeMessage('recipes:setFavorite')
  setFavorite(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesSetFavoritePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      const result = await this.recipesService.setFavorite(
        userId,
        payload.data,
      );
      broadcastToHousehold(
        this.server,
        payload.data.householdId,
        'recipes:favoritesChanged',
        {
          householdId: payload.data.householdId,
          recipeId: payload.data.recipeId,
          isFavorite: payload.data.isFavorite,
          changedByUserId: userId,
        },
      );
      return result;
    });
  }
}
