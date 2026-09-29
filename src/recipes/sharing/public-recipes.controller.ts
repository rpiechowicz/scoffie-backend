import { Controller, Get, Header, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { readThrottleLimit } from '../../common/throttle/throttle-env';
import { PublicRecipe, RecipeSharingService } from './recipe-sharing.service';

/**
 * Publiczne dane udostępnionego przepisu dla strony `scoffie.app/przepis/…`
 * (karta podglądu w komunikatorach + chuda strona dla osób bez aplikacji).
 *
 * BEZ logowania, celowo wąsko: tylko to, co i tak widzi odbiorca linku —
 * bez autora, domu, id i kroków (kroki są w aplikacji). Nie ma tu listy ani
 * wyszukiwania: katalog da się oglądać wyłącznie przepis po przepisie.
 * Każdy brak (zły adres, wycofany przepis, wyłączony link) to ten sam 404.
 *
 * Cache: katalog zmienia się rzadko (5 min), link gospodarstwa krócej —
 * „Wyłącz link” ma zadziałać szybko także na brzegu Cloudflare.
 */
@Controller('public/recipes')
@Throttle({
  default: { limit: () => readThrottleLimit('THROTTLE_PUBLIC_LIMIT') },
})
export class PublicRecipesController {
  constructor(private readonly sharing: RecipeSharingService) {}

  @Get('slug/:slug')
  @Header('Cache-Control', 'public, max-age=300')
  bySlug(@Param('slug') slug: string): Promise<PublicRecipe> {
    return this.sharing.publicBySlug(slug);
  }

  @Get('shared/:token')
  @Header('Cache-Control', 'public, max-age=60')
  byToken(@Param('token') token: string): Promise<PublicRecipe> {
    return this.sharing.publicByToken(token);
  }
}
