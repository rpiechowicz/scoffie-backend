import { Controller, Get, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { readThrottleLimit } from '../../common/throttle/throttle-env';
import {
  PublicCatalogIndex,
  PublicRecipe,
  RecipeSharingService,
} from './recipe-sharing.service';

/**
 * Publiczne dane udostępnionego przepisu dla strony `scoffie.app/przepis/…`
 * (karta podglądu w komunikatorach + chuda strona dla osób bez aplikacji).
 *
 * BEZ logowania, celowo wąsko: tylko to, co i tak widzi odbiorca linku —
 * bez autora, domu, id i kroków (kroki są w aplikacji). Jedyna lista to spis
 * slugów KATALOGU do mapy strony (8.10.2026: katalog w wyszukiwarkach);
 * wyszukiwania nie ma, a przepisy gospodarstw dalej tylko po tokenie.
 * Każdy brak (zły adres, wycofany przepis, wyłączony link) to ten sam 404.
 *
 * Cache TYLKO dla sukcesu: katalog zmienia się rzadko (5 min), link
 * gospodarstwa krócej — „Wyłącz link” ma zadziałać szybko także na brzegu.
 * `@Header()` Nesta ustawia nagłówek zanim wiadomo, jak skończy się handler,
 * więc 404 też dostawała `public, max-age` — stąd ręcznie, po odczycie.
 */
@Controller('public/recipes')
@Throttle({
  default: { limit: () => readThrottleLimit('THROTTLE_PUBLIC_LIMIT') },
})
export class PublicRecipesController {
  constructor(private readonly sharing: RecipeSharingService) {}

  /** Slugi aktywnego katalogu do `sitemap.xml` strony; godzina cache wystarczy. */
  @Get('catalog')
  async catalog(
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicCatalogIndex> {
    const index = await this.sharing.publicCatalogIndex();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return index;
  }

  @Get('slug/:slug')
  async bySlug(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicRecipe> {
    const recipe = await this.sharing.publicBySlug(slug);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return recipe;
  }

  @Get('shared/:token')
  async byToken(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicRecipe> {
    const recipe = await this.sharing.publicByToken(token);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return recipe;
  }
}
