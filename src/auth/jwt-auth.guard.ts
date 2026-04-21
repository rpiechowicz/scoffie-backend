import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

type RequestWithUser = Request & { user?: { id: string } };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const header = request.headers?.['authorization'] ?? '';
    const [type, token] = Array.isArray(header)
      ? header[0].split(' ')
      : header.split(' ');

    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
      request.user = { id: payload.sub };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
