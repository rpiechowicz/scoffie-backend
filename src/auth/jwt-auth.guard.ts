import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AppException } from '../common/app-exception';
import { AccessTokenService, parseBearer } from './access-token.service';
import { UserActivityService } from './user-activity.service';

type RequestWithUser = Request & { user?: { id: string } };

/**
 * REST: `Authorization: Bearer <access token>` → `request.user.id`.
 * Ta sama weryfikacja co handshake WS (`AccessTokenService`): podpis, `exp`
 * i istnienie usera. Odmowa zawsze jako `UNAUTHORIZED` z powodem w `details`.
 * Rozpoznana osoba liczy się do aktywności dnia (`UserActivityService` —
 * raz na dobę, bez czekania na zapis).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly activity: UserActivityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = parseBearer(request.headers?.['authorization']);

    if (!token) {
      throw new AppException(
        'UNAUTHORIZED',
        'Missing or invalid Authorization header',
        HttpStatus.UNAUTHORIZED,
        ['missing'],
      );
    }

    const verdict = await this.accessTokens.verify(token);
    if (!verdict.ok) {
      throw new AppException(
        'UNAUTHORIZED',
        'Invalid or expired token',
        HttpStatus.UNAUTHORIZED,
        [verdict.reason],
      );
    }

    request.user = { id: verdict.userId };
    this.activity.record(verdict.userId);
    return true;
  }
}
