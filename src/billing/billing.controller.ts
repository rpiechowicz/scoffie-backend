import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { AppleJwsError } from './apple-jws.verifier';
import { readBillingEnv } from './billing-env';
import { BillingPreflightService } from './billing-preflight.service';
import { SubscriptionsService } from './subscriptions.service';

/** Podpisana transakcja StoreKit 2 — bywa długa, ale nie nieskończona. */
export class RegisterTransactionDto {
  @IsString()
  @MinLength(20)
  @MaxLength(20000)
  signedTransaction!: string;
}

/** Koperta powiadomienia App Store Server Notifications v2. */
export class AppleNotificationDto {
  @IsString()
  @MinLength(20)
  @MaxLength(100000)
  signedPayload!: string;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly preflight: BillingPreflightService,
  ) {}

  /**
   * Stan subskrypcji tej osoby.
   *
   * App Store 3.1.2(a) wymaga, żeby stan subskrypcji dało się zobaczyć w
   * aplikacji, a nie tylko w ustawieniach iOS — a asystent to nie jedyne
   * miejsce, w którym trzeba o niego zapytać, więc endpoint stoi poza
   * modułem AI.
   */
  @Get('subscription')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Subskrypcje zalogowanej osoby' })
  async subscription(@CurrentUserId() userId: string) {
    const env = readBillingEnv();
    const items = await this.subscriptions.forUser(userId);
    return {
      // Telefon musi wiedzieć, czy w ogóle pokazywać przycisk zakupu —
      // paywall, który przyjmuje pieniądze bez działającej weryfikacji, jest
      // gorszy niż brak paywalla.
      //
      // NIEPUSTE ZMIENNE TO ZA MAŁO. Klucz App Store Connect API wklejony
      // zamiast klucza In-App Purchase wygląda tak samo i podpisuje tak samo,
      // a Apple odpowiada na niego 401. Dlatego druga bramka pyta Apple
      // NAPRAWDĘ, raz przy starcie, i gasi sprzedaż, gdy token jest odrzucany.
      purchasesEnabled: env.enabled && this.preflight.wolnoSprzedawac(),
      environment: env.environment,
      subscriptions: items,
    };
  }

  /**
   * Zgłoszenie zakupu z telefonu. Zgłoszenie, nie nadanie: stan i tak
   * pochodzi z App Store Server API.
   */
  @Post('apple/transaction')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Zgłoszenie transakcji App Store' })
  async registerTransaction(
    @CurrentUserId() userId: string,
    @Body() dto: RegisterTransactionDto,
  ) {
    const summary = await this.subscriptions.registerAppleTransaction(
      userId,
      dto.signedTransaction,
    );
    return { subscription: summary };
  }

  /**
   * Powiadomienia serwera Apple (App Store Server Notifications v2).
   *
   * BEZ `JwtAuthGuard` — to Apple wywołuje ten adres, nie użytkownik.
   * Uwierzytelnieniem jest podpis ładunku sprawdzony do przypiętego korzenia;
   * ktokolwiek inny dostanie 400 i niczego nie zapisze.
   *
   * `@SkipThrottle` jest tu konieczne, a nie wygodne: globalny limiter liczy po
   * adresie IP, a Apple wysyła wszystko z własnej puli adresów. Odbicie
   * powiadomienia 429-tką wygląda dla Apple jak awaria — ponowi pięć razy przez
   * trzy doby, a potem przestanie i zdarzenie przepadnie na zawsze.
   *
   * 200 dopiero PO trwałym zapisie. Kolejność „zapisz surowy ładunek →
   * przetwórz → odpowiedz" oznacza, że deploy w złej sekundzie kosztuje
   * najwyżej jedno ponowienie, a nie utratę zdarzenia.
   */
  @Post('apple/notifications')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Powiadomienie App Store Server Notifications v2' })
  async notification(@Body() dto: AppleNotificationDto) {
    let stored;
    try {
      stored = await this.subscriptions.recordNotification(dto.signedPayload);
    } catch (error) {
      if (error instanceof AppleJwsError) {
        this.logger.warn(
          `Odrzucone powiadomienie (${error.code}): ${error.message}`,
        );
        throw new AppException(
          'BILLING_NOTIFICATION_INVALID',
          'Nie udało się potwierdzić podpisu powiadomienia.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }

    if (stored.duplicate) {
      // Apple ponawia — to jest normalne i nie jest błędem.
      return { received: true, duplicate: true };
    }

    // Zdarzenie jest już trwale zapisane. Gdyby przetwarzanie padło, zwracamy
    // błąd, żeby Apple ponowiło — a ponowienie trafi na zapisany, jeszcze
    // nieprzetworzony wiersz i spróbuje jeszcze raz zamiast go zdublować.
    await this.subscriptions.processNotification(stored.uuid);
    return { received: true, duplicate: false };
  }
}
