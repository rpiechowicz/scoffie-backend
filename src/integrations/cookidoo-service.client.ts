import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';

export type CookidooSubscriptionInfo = {
  active: boolean;
  type: string | null;
  expiresAt: string | null;
};

type ServiceErrorBody = {
  detail?: { code?: string; message?: string };
};

// Cienki klient HTTP do mikroserwisu weekly-meals-cookidoo. Globalny fetch
// Node 20 zamiast nowej zależności — to pierwszy „zwykły" outbound HTTP
// w repo. Nigdy nie loguje body (w środku są poświadczenia Cookidoo).
@Injectable()
export class CookidooServiceClient {
  private readonly logger = new Logger(CookidooServiceClient.name);
  private readonly baseUrl = (
    process.env.COOKIDOO_SERVICE_URL ?? 'http://localhost:8000'
  ).replace(/\/+$/, '');
  private readonly token = process.env.COOKIDOO_SERVICE_TOKEN ?? '';
  private readonly timeoutMs = Number(
    process.env.COOKIDOO_SERVICE_TIMEOUT_MS ?? 15000,
  );

  async validateCredentials(
    email: string,
    password: string,
  ): Promise<{ subscription: CookidooSubscriptionInfo | null }> {
    const body = await this.post<{
      valid: boolean;
      subscription: CookidooSubscriptionInfo | null;
    }>('/v1/credentials/validate', { email, password });
    return { subscription: body.subscription ?? null };
  }

  async addToWeek(payload: {
    sessionKey: string;
    email: string;
    password: string;
    recipeId: string;
    date: string;
  }): Promise<void> {
    await this.post('/v1/my-week/add', payload);
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.logger.error(
        `Mikroserwis Cookidoo nieosiągalny (${path}): ${String(error)}`,
      );
      throw new AppException(
        'COOKIDOO_SERVICE_UNAVAILABLE',
        'Usługa Cookidoo jest chwilowo niedostępna.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const errorBody = (await response
      .json()
      .catch(() => ({}))) as ServiceErrorBody;
    const code = errorBody.detail?.code;

    switch (code) {
      case 'COOKIDOO_AUTH_FAILED':
        // 409, nie 401 — patrz komentarz w app-error-code.ts.
        throw new AppException(
          'COOKIDOO_AUTH_FAILED',
          'Logowanie do Cookidoo nie powiodło się.',
          HttpStatus.CONFLICT,
        );
      case 'COOKIDOO_RECIPE_NOT_FOUND':
        throw new AppException(
          'COOKIDOO_RECIPE_NOT_FOUND',
          'Cookidoo nie zna przepisu o podanym id.',
          HttpStatus.NOT_FOUND,
        );
      case 'INTERNAL_UNAUTHORIZED':
        // Rozjazd sekretów Nest <-> Python to błąd konfiguracji, nie użytkownika.
        this.logger.error(
          'Mikroserwis Cookidoo odrzucił X-Internal-Token — sprawdź COOKIDOO_SERVICE_TOKEN.',
        );
        throw new AppException(
          'COOKIDOO_SERVICE_UNAVAILABLE',
          'Usługa Cookidoo jest błędnie skonfigurowana.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      default:
        this.logger.error(
          `Mikroserwis Cookidoo zwrócił ${response.status} (${path}), code=${code ?? 'brak'}`,
        );
        throw new AppException(
          'COOKIDOO_SERVICE_UNAVAILABLE',
          'Usługa Cookidoo jest chwilowo niedostępna.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
    }
  }
}
