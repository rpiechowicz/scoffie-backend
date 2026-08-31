import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Id użytkownika wpisane do requestu przez `JwtAuthGuard` — jedyne źródło
 * „kto to robi" po HTTP, dokładnie jak `actorId` po WebSockecie. Klient nigdy
 * nie deklaruje tożsamości w body.
 *
 * Mieszkał w `src/integrations/` (pierwszy moduł na JWT); przeniesiony do
 * `src/auth/`, gdy asystent stał się drugim takim modułem — dekorator należy
 * do warstwy, która ustawia `request.user`, nie do jej pierwszego klienta.
 * `src/integrations/current-user-id.decorator.ts` re-eksportuje go dalej.
 */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { id: string } }>();
    return request.user?.id ?? '';
  },
);
