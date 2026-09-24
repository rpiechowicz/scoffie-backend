import {
  Body,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { assertUuid } from '../../common/uuid';
import { AdminController } from '../admin-controller.decorator';
import type { AdminAccessContext } from '../admin-request';
import {
  AdminAccess,
  AdminSessionMode,
  AllowDuringReenroll,
  CurrentAdminSession,
  RequireStepUp,
} from '../admin.decorators';
import type {
  AdminPasskey,
  AdminSession as AdminSessionView,
  AdminSessionInfo,
  AuthState,
} from '../contract';
import { AdminAuthException } from './admin-auth.errors';
import {
  AdminCodeDto,
  AdminPasskeyLoginDto,
  AdminPasskeyRegisterDto,
  AdminPasskeyRegisterOptionsDto,
  AdminStepUpDto,
} from './admin-auth.dto';
import { AdminAuthService } from './admin-auth.service';
import {
  AdminSessionsService,
  clearSessionCookie,
  setSessionCookie,
  type ResolvedAdminSession,
} from './admin-sessions.service';

/**
 * Logowanie i konfiguracja wejścia do panelu — kontrakt w
 * `docs/plans/scoffie-admin/API-AUTH.md`. Wszystko za bramką Access (bez
 * niej 404); trasy logowania nie wymagają sesji (`none`), rejestracja
 * passkeya przyjmuje ją opcjonalnie (bootstrap pierwszego konta).
 */
@AdminController('auth')
export class AdminAuthController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly sessions: AdminSessionsService,
  ) {}

  @Get('state')
  @AdminSessionMode('none')
  state(@AdminAccess() access: AdminAccessContext): Promise<AuthState> {
    return this.auth.state(access);
  }

  @Post('passkey/login/options')
  @AdminSessionMode('none')
  passkeyLoginOptions(@AdminAccess() access: AdminAccessContext) {
    return this.auth.passkeyLoginOptions(access);
  }

  @Post('passkey/login')
  @AdminSessionMode('none')
  async passkeyLogin(
    @AdminAccess() access: AdminAccessContext,
    @Body() dto: AdminPasskeyLoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSessionView> {
    const opened = await this.auth.passkeyLogin(access, dto.response);
    setSessionCookie(res, opened.token);
    return opened.view;
  }

  @Post('totp/login')
  @AdminSessionMode('none')
  async totpLogin(
    @AdminAccess() access: AdminAccessContext,
    @Body() dto: AdminCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSessionView> {
    const opened = await this.auth.totpLogin(access, dto.code);
    setSessionCookie(res, opened.token);
    return opened.view;
  }

  @Post('recovery/login')
  @AdminSessionMode('none')
  async recoveryLogin(
    @AdminAccess() access: AdminAccessContext,
    @Body() dto: AdminCodeDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminSessionView> {
    const opened = await this.auth.recoveryLogin(access, dto.code);
    setSessionCookie(res, opened.token);
    return opened.view;
  }

  @Post('passkey/register/options')
  @AdminSessionMode('optional')
  @AllowDuringReenroll()
  passkeyRegisterOptions(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    // Nazwa przychodzi też tu (kontrakt panelu), zapisuje ją dopiero `register`.
    @Body() _dto: AdminPasskeyRegisterOptionsDto,
  ) {
    return this.auth.passkeyRegisterOptions(access, session);
  }

  @Post('passkey/register')
  @AdminSessionMode('optional')
  @AllowDuringReenroll()
  async passkeyRegister(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminPasskeyRegisterDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminPasskey> {
    const { passkey, opened } = await this.auth.passkeyRegister(
      access,
      session,
      dto.name,
      dto.response,
    );
    if (opened) setSessionCookie(res, opened.token);
    return passkey;
  }

  @Post('totp/setup')
  @AllowDuringReenroll()
  totpSetup(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ) {
    return this.auth.totpSetup(access, this.must(session));
  }

  @Post('totp/confirm')
  @AllowDuringReenroll()
  totpConfirm(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminCodeDto,
  ) {
    return this.auth.totpConfirm(access, this.must(session), dto.code);
  }

  @Post('recovery/regenerate')
  @RequireStepUp()
  regenerateRecoveryCodes(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ) {
    return this.auth.regenerateRecoveryCodes(access, this.must(session));
  }

  @Post('step-up/options')
  stepUpOptions(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ) {
    return this.auth.stepUpOptions(access, this.must(session));
  }

  @Post('step-up')
  stepUp(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Body() dto: AdminStepUpDto,
  ): Promise<{ stepUpUntil: string }> {
    if (!dto.passkey && typeof dto.totp !== 'string') {
      throw new AdminAuthException('INVALID_CODE');
    }
    return this.auth.stepUp(access, this.must(session), dto);
  }

  @Get('sessions')
  list(
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ): Promise<AdminSessionInfo[]> {
    const current = this.must(session);
    return this.sessions.list(current.adminUserId, current.id);
  }

  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { current } = await this.auth.revokeSession(
      access,
      this.must(session),
      assertUuid(rawId, 'id'),
    );
    if (current) clearSessionCookie(res);
  }

  @Get('passkeys')
  @AllowDuringReenroll()
  passkeys(
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ): Promise<AdminPasskey[]> {
    return this.auth.passkeys(this.must(session));
  }

  @Delete('passkeys/:id')
  @RequireStepUp()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePasskey(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Param('id') rawId: string,
  ): Promise<void> {
    await this.auth.deletePasskey(
      access,
      this.must(session),
      assertUuid(rawId, 'id'),
    );
  }

  /** Trasy `required` mają sesję z guarda; to tylko zawężenie typu. */
  private must(session: ResolvedAdminSession | null): ResolvedAdminSession {
    if (!session)
      throw new Error('trasa panelu wymaga sesji — brak AdminGuard?');
    return session;
  }
}

/** Bieżąca sesja panelu: `GET` — kim jestem, `DELETE` — wyloguj. */
@AdminController('session')
export class AdminSessionController {
  constructor(private readonly auth: AdminAuthService) {}

  @Get()
  @AllowDuringReenroll()
  current(
    @CurrentAdminSession() session: ResolvedAdminSession | null,
  ): Promise<AdminSessionView> {
    if (!session)
      throw new Error('trasa panelu wymaga sesji — brak AdminGuard?');
    return this.auth.view(session);
  }

  /** Zawsze 204 i skasowane ciasteczko — wylogowanie nie może się „nie udać”. */
  @Delete()
  @AdminSessionMode('optional')
  @AllowDuringReenroll()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @AdminAccess() access: AdminAccessContext,
    @CurrentAdminSession() session: ResolvedAdminSession | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(access, session);
    clearSessionCookie(res);
  }
}
