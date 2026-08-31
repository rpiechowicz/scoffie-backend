import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { actorId } from '../common/ws-socket';
import type { AppSocket } from '../common/ws-socket';
import { broadcastToHousehold } from '../common/ws-rooms';
import { validateWsPayload } from '../common/validate-dto';
import { RecipesService } from './recipes.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { SearchIngredientsDto } from './dto/search-ingredients.dto';
import { IngredientsService } from './ingredients.service';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';

// Koperty zdarzeń: KAŻDE pole ma dekorator, bo `validateWsPayload` działa
// z whitelistą i wycina pola bez dekoratora. `data`/`filters` tylko
// `@IsObject()` — zawartość waliduje serwis (każde pole dokładnie raz).

class RecipesFindAllPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsUUID()
  householdId?: string;

  @IsOptional()
  @IsObject()
  filters?: FindRecipesDto;
}

class IngredientsSearchPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsObject()
  filters?: SearchIngredientsDto;
}

class RecipesFindByIdPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  id: string;

  @IsOptional()
  @IsUUID()
  householdId?: string;
}

class RecipesCreatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsObject()
  data: CreateRecipeDto;
}

class RecipesSetFavoritePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsObject()
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
    private readonly ingredientsService: IngredientsService,
    private readonly wsTelemetry: WsTelemetryService,
  ) {}

  handleConnection(_client: Socket) {
    this.wsTelemetry.onConnect(RecipesGateway.name);
  }

  handleDisconnect(_client: Socket) {
    this.wsTelemetry.onDisconnect(RecipesGateway.name);
  }

  // Kolejność w każdym handlerze: NAJPIERW tożsamość, POTEM koperta —
  // anonimowy socket ma dostać UNAUTHORIZED, nie VALIDATION_ERROR.

  @SubscribeMessage('recipes:findAll')
  findAll(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesFindAllPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesFindAllPayload, payload);
      // Koperta ma same pola opcjonalne, więc `payload === undefined` przechodzi
      // walidację — `?.` zamiast TypeError → INTERNAL_ERROR.
      return this.recipesService.findAll(userId, payload?.filters);
    });
  }

  /**
   * Składnik po NAZWIE — jedyna droga od „pierś z kurczaka" do identyfikatora,
   * którego wymaga `recipes:create`. Katalog składników jest wspólny, więc
   * wynik nie zależy od gospodarstwa; wystarczy być zalogowanym.
   */
  @SubscribeMessage('ingredients:search')
  searchIngredients(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: IngredientsSearchPayload,
  ) {
    return wsRespond(async () => {
      actorId(client, payload);
      // Zwalidowana koperta, nie surowa: `payload` bywa `undefined` (stare
      // buildy wołają bez argumentu), a `validateWsPayload` sprowadza to do
      // pustego obiektu i przy okazji obcina pola spoza whitelisty.
      const envelope = await validateWsPayload(
        IngredientsSearchPayload,
        payload,
      );
      return this.ingredientsService.search(envelope.filters ?? {});
    });
  }

  @SubscribeMessage('recipes:findById')
  findById(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesFindByIdPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesFindByIdPayload, payload);
      return this.recipesService.findById(
        userId,
        payload.id,
        payload.householdId,
      );
    });
  }

  @SubscribeMessage('recipes:create')
  create(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesCreatePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesCreatePayload, payload);
      return this.recipesService.create(userId, payload.data);
    });
  }

  @SubscribeMessage('recipes:setFavorite')
  setFavorite(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesSetFavoritePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesSetFavoritePayload, payload);
      const { recipe, change } = await this.recipesService.setFavorite(
        userId,
        payload.data,
      );
      // Broadcast ze ZWALIDOWANEJ zmiany (serwis ją oddaje), nie z surowego
      // `payload.data` — do pokoju leci to, co faktycznie zapisano.
      broadcastToHousehold(
        this.server,
        change.householdId,
        'recipes:favoritesChanged',
        {
          householdId: change.householdId,
          recipeId: change.recipeId,
          isFavorite: change.isFavorite,
          changedByUserId: userId,
        },
      );
      // Ack bez zmian dla iOS: szczegóły przepisu, jak przed Fazą 0.
      return recipe;
    });
  }
}
