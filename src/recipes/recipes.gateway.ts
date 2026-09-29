import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WS_GATEWAY_OPTIONS } from '../common/ws-gateway-options';
import { wsRespond } from '../common/ws-response';
import { actorId } from '../common/ws-socket';
import type { AppSocket } from '../common/ws-socket';
import { broadcastToHousehold } from '../common/ws-rooms';
import { validateWsPayload } from '../common/validate-dto';
import { RecipesService } from './recipes.service';
import {
  CATALOG_SYNC_MAX_LIMIT,
  CatalogSyncService,
} from './catalog-sync.service';
import { CreateRecipeDto } from './dto/create-recipe.dto';
import { UpdateRecipeFavoriteDto } from './dto/update-recipe-favorite.dto';
import { FindRecipesDto } from './dto/find-recipes.dto';
import { UpdateRecipeDto } from './dto/update-recipe.dto';
import { SearchIngredientsDto } from './dto/search-ingredients.dto';
import { IngredientsService } from './ingredients.service';
import { Server, Socket } from 'socket.io';
import { WsTelemetryService } from '../common/ws-telemetry.service';
import { RecipeSharingService } from './sharing/recipe-sharing.service';

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

/** `catalog:snapshot` — cały publiczny katalog stronami (Etap 4A). */
class CatalogSnapshotPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  /** Znacznik z PIERWSZEJ strony tego przebiegu; brak = nowy przebieg. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  revision?: string;

  /** `nextCursor` z poprzedniej strony. */
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CATALOG_SYNC_MAX_LIMIT)
  limit?: number;
}

/** `catalog:changes` — zmiany katalogu od rewizji klienta (Etap 4A). */
class CatalogChangesPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  /** Rewizja, którą klient ma w całości zastosowaną. */
  @IsString()
  @MaxLength(64)
  sinceRevision: string;

  /** `revision` z PIERWSZEJ strony tego przebiegu delty. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  untilRevision?: string;

  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(CATALOG_SYNC_MAX_LIMIT)
  limit?: number;
}

/** `recipes:householdState` — przepisy gospodarstwa i ulubione (Etap 4A). */
class RecipesHouseholdStatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;
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

class RecipesUpdatePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  id: string;

  @IsObject()
  data: UpdateRecipeDto;
}

class RecipesDeletePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  id: string;

  @IsUUID()
  householdId: string;
}

class RecipesSetFavoritePayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsObject()
  data: UpdateRecipeFavoriteDto;
}

/**
 * Udostępnianie (`recipes:shareLink`, `recipes:revokeShare`, `recipes:shared`)
 * — przepis w domu pytającego. Kontrakt:
 * `docs/plans/udostepnianie-przepisow/KONTRAKT.md`.
 */
class RecipesShareTargetPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;

  @IsUUID()
  recipeId: string;
}

/**
 * `recipes:openShared` — link otwarty w aplikacji: slug katalogu (też UUID
 * i stary slug) ALBO token linku gospodarstwa. Kształt slugu/tokenu sprawdza
 * serwis — zły to ten sam 404 co wyłączony link, nie błąd walidacji.
 */
class RecipesOpenSharedPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  token?: string;
}

/** `recipes:saveShared` — „Zapisz u siebie” z linku gospodarstwa. */
class RecipesSaveSharedPayload {
  /** Legacy: tożsamość jest w socket.data; pole ignorowane dla socketów z tokenem. */
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;

  @IsString()
  @MaxLength(64)
  token: string;
}

@WebSocketGateway(WS_GATEWAY_OPTIONS)
export class RecipesGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  private server: Server;

  constructor(
    private readonly recipesService: RecipesService,
    private readonly catalogSync: CatalogSyncService,
    private readonly ingredientsService: IngredientsService,
    private readonly wsTelemetry: WsTelemetryService,
    private readonly sharing: RecipeSharingService,
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
   * Snapshot PUBLICZNEGO katalogu (Etap 4A): strony po `id` z rewizją
   * ustaloną na pierwszej stronie. Bez gospodarstwa — katalog jest wspólny,
   * wystarczy zalogowany socket. `recipes:findAll` zostaje dla starszych
   * buildów iOS.
   */
  @SubscribeMessage('catalog:snapshot')
  catalogSnapshot(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CatalogSnapshotPayload,
  ) {
    return wsRespond(async () => {
      actorId(client, payload);
      const envelope = await validateWsPayload(CatalogSnapshotPayload, payload);
      // Same pola protokołu — legacy `userId` z koperty nie idzie dalej.
      return this.catalogSync.snapshot({
        revision: envelope.revision,
        cursor: envelope.cursor,
        limit: envelope.limit,
      });
    });
  }

  /**
   * Zmiany katalogu od rewizji klienta (Etap 4A): upserty i tombstone'y
   * albo `RESET_REQUIRED`, gdy delty nie da się uczciwie odtworzyć.
   */
  @SubscribeMessage('catalog:changes')
  catalogChanges(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: CatalogChangesPayload,
  ) {
    return wsRespond(async () => {
      actorId(client, payload);
      const envelope = await validateWsPayload(CatalogChangesPayload, payload);
      return this.catalogSync.changes({
        sinceRevision: envelope.sinceRevision,
        untilRevision: envelope.untilRevision,
        cursor: envelope.cursor,
        limit: envelope.limit,
      });
    });
  }

  /**
   * Przepisy gospodarstwa i ulubione — obok publicznego katalogu, bo do
   * jego logu synchronizacji nie wchodzą (Etap 4A).
   */
  @SubscribeMessage('recipes:householdState')
  householdState(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesHouseholdStatePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesHouseholdStatePayload, payload);
      return this.recipesService.householdState(userId, payload.householdId);
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

  /**
   * Poprawka przepisu gospodarstwa. Domyka pętlę „zaproponuj → popraw →
   * zapisz", której do Fazy 1 nie było — asystent umiał tylko utworzyć.
   */
  @SubscribeMessage('recipes:update')
  update(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesUpdatePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesUpdatePayload, payload);
      const recipe = await this.recipesService.update(
        userId,
        payload.id,
        payload.data,
      );
      this.broadcastRecipeChange(
        payload.data.householdId,
        payload.id,
        'UPDATED',
        userId,
      );
      return recipe;
    });
  }

  /** Wycofanie przepisu (`isActive = false`), nie twarde kasowanie. */
  @SubscribeMessage('recipes:delete')
  remove(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesDeletePayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesDeletePayload, payload);
      const result = await this.recipesService.remove(
        userId,
        payload.id,
        payload.householdId,
      );
      this.broadcastRecipeChange(
        payload.householdId,
        payload.id,
        'DELETED',
        userId,
      );
      return result;
    });
  }

  /**
   * Adres do arkusza „Udostępnij”: katalog → `/przepis/<slug>`, przepis domu
   * → aktywny link `/przepis/u/<token>` (pierwszy raz: nowy — wtedy domownicy
   * dostają `recipes:changed`, żeby zobaczyć `shareUrl` i „Wyłącz link”).
   */
  @SubscribeMessage('recipes:shareLink')
  shareLink(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesShareTargetPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesShareTargetPayload, payload);
      const { created, ...link } = await this.sharing.shareLink(
        userId,
        payload.householdId,
        payload.recipeId,
      );
      if (created) {
        this.broadcastRecipeChange(
          payload.householdId,
          payload.recipeId,
          'UPDATED',
          userId,
        );
      }
      return link;
    });
  }

  /** „Wyłącz link” — gasi aktywny link przepisu domu. */
  @SubscribeMessage('recipes:revokeShare')
  revokeShare(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesShareTargetPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesShareTargetPayload, payload);
      const result = await this.sharing.revokeShare(
        userId,
        payload.householdId,
        payload.recipeId,
      );
      if (result.revoked) {
        this.broadcastRecipeChange(
          payload.householdId,
          payload.recipeId,
          'UPDATED',
          userId,
        );
      }
      return result;
    });
  }

  /** Licznik „udostępniono” — klient woła PO zakończonym arkuszu systemowym. */
  @SubscribeMessage('recipes:shared')
  shared(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesShareTargetPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesShareTargetPayload, payload);
      return this.sharing.recordShared(
        userId,
        payload.householdId,
        payload.recipeId,
      );
    });
  }

  /** Link otwarty w aplikacji → przepis + skąd pochodzi (`origin`). */
  @SubscribeMessage('recipes:openShared')
  openShared(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesOpenSharedPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesOpenSharedPayload, payload);
      return this.sharing.openShared(userId, payload.householdId, {
        slug: payload.slug,
        token: payload.token,
      });
    });
  }

  /** „Zapisz u siebie” — kopia przepisu z linku w domu pytającego. */
  @SubscribeMessage('recipes:saveShared')
  saveShared(
    @ConnectedSocket() client: AppSocket,
    @MessageBody() payload: RecipesSaveSharedPayload,
  ) {
    return wsRespond(async () => {
      const userId = actorId(client, payload);
      await validateWsPayload(RecipesSaveSharedPayload, payload);
      const result = await this.sharing.saveShared(
        userId,
        payload.householdId,
        payload.token,
      );
      if (result.created) {
        this.broadcastRecipeChange(
          payload.householdId,
          result.recipe.id,
          'CREATED',
          userId,
        );
      }
      return result;
    });
  }

  /**
   * Sygnał „katalog gospodarstwa się zmienił".
   *
   * Zdarzenie jest nowe i obecny build iOS go nie zna — nieznane zdarzenie
   * Socket.IO jest po prostu ignorowane, więc nic się nie psuje, a klient
   * odświeży listę jak dotąd (foreground / 12 h). Nadajemy je już teraz, żeby
   * po stronie iOS został do zrobienia sam nasłuch, a nie kontrakt.
   */
  private broadcastRecipeChange(
    householdId: string,
    recipeId: string,
    action: 'CREATED' | 'UPDATED' | 'DELETED',
    changedByUserId: string,
  ): void {
    broadcastToHousehold(this.server, householdId, 'recipes:changed', {
      householdId,
      recipeId,
      action,
      changedByUserId,
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
