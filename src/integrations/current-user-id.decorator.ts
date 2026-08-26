import { createParamDecorator, ExecutionContext } from '@nestjs/common';

// Id użytkownika wpisane do requestu przez JwtAuthGuard. Pierwszy moduł
// w repo, który bierze tożsamość z tokenu zamiast z payloadu wiadomości —
// przy poświadczeniach Cookidoo klient nie może sam deklarować, kim jest.
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { id: string } }>();
    return request.user?.id ?? '';
  },
);
