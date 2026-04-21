import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { Request } from 'express';

type RequestWithUser = Request & { user?: { id: string } };

@Injectable()
export class RollingTokenInterceptor implements NestInterceptor {
  constructor(private readonly authService: AuthService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse();

    return next.handle().pipe(
      mergeMap(async (data) => {
        if (request.user?.id) {
          const token = await this.authService.issueAccessToken(
            request.user.id,
          );
          response.setHeader('x-access-token', token);
        }
        return data;
      }),
    );
  }
}
