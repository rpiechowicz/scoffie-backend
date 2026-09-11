import { Injectable } from '@nestjs/common';
import { readMailEnv } from './mail-env';
import { MailCtx, ctx } from './templates/mail-kit';
import {
  AccountDeletedPayload,
  AiQuotaExhaustedPayload,
  AiTrialExhaustedPayload,
  HouseholdJoinedPayload,
  LegalUpdatePayload,
  MailTemplateId,
  RenderedMail,
  SubscriptionExpiredPayload,
  SubscriptionGracePayload,
  WelcomePayload,
} from './mail-template';
import { renderWelcome } from './templates/welcome.template';
import { renderHouseholdJoined } from './templates/household-joined.template';
import {
  renderAiQuotaExhausted,
  renderAiTrialExhausted,
} from './templates/ai-quota.template';
import {
  renderSubscriptionExpired,
  renderSubscriptionGrace,
} from './templates/subscription.template';
import { renderAccountDeleted } from './templates/account-deleted.template';
import { renderLegalUpdate } from './templates/legal-update.template';

/**
 * Renderer: identyfikator szablonu + `payload` z bazy → gotowa wiadomość.
 *
 * SPRAWDZA KSZTAŁT DANYCH I RZUCA. Wiersz skrzynki nadawczej leży w bazie
 * jako `Json`, więc do renderowania trafia byle co — a `undefined` wstawiony
 * w treść wychodzi jako „undefined" w mailu do prawdziwej osoby. Lepszy
 * wiersz `FAILED` z czytelnym powodem niż wysłana wiadomość z dziurą.
 */
@Injectable()
export class MailRenderer {
  render(
    template: MailTemplateId,
    payload: Record<string, unknown>,
  ): RenderedMail {
    const env = readMailEnv();
    const c = ctx({ assetBase: env.assetBaseUrl, site: env.siteUrl });
    return this.renderWith(c, template, payload);
  }

  /** Osobno, żeby podgląd mógł podać własną szerokość (320 px). */
  renderWith(
    c: MailCtx,
    template: MailTemplateId,
    payload: Record<string, unknown>,
  ): RenderedMail {
    switch (template) {
      case 'WELCOME':
        return renderWelcome(c, this.welcome(payload));
      case 'HOUSEHOLD_JOINED':
        return renderHouseholdJoined(c, this.householdJoined(payload));
      case 'AI_TRIAL_EXHAUSTED':
        return renderAiTrialExhausted(c, this.aiTrial(payload));
      case 'AI_QUOTA_EXHAUSTED':
        return renderAiQuotaExhausted(c, this.aiQuota(payload));
      case 'SUBSCRIPTION_GRACE':
        return renderSubscriptionGrace(c, this.grace(payload));
      case 'SUBSCRIPTION_EXPIRED':
        return renderSubscriptionExpired(c, this.expired(payload));
      case 'ACCOUNT_DELETED':
        return renderAccountDeleted(c, this.accountDeleted(payload));
      case 'LEGAL_UPDATE':
        return renderLegalUpdate(c, this.legalUpdate(payload));
    }
  }

  /* ── sprawdzanie pól ──────────────────────────────────────────────────── */

  private str(p: Record<string, unknown>, key: string): string {
    const value = p[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`brak pola tekstowego "${key}"`);
    }
    return value;
  }

  private strOrNull(p: Record<string, unknown>, key: string): string | null {
    const value = p[key];
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string')
      throw new Error(`pole "${key}" nie jest tekstem`);
    return value;
  }

  private num(p: Record<string, unknown>, key: string): number {
    const value = p[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`brak liczby "${key}"`);
    }
    return value;
  }

  private bool(p: Record<string, unknown>, key: string): boolean {
    const value = p[key];
    if (typeof value !== 'boolean') throw new Error(`brak flagi "${key}"`);
    return value;
  }

  private counter(
    p: Record<string, unknown>,
    key: string,
  ): 'messages' | 'plans' {
    const value = p[key];
    if (value !== 'messages' && value !== 'plans') {
      throw new Error(`pole "${key}" musi być "messages" albo "plans"`);
    }
    return value;
  }

  /* ── payloady ─────────────────────────────────────────────────────────── */

  private welcome(p: Record<string, unknown>): WelcomePayload {
    return {
      displayName: this.str(p, 'displayName'),
      trialMessages: this.num(p, 'trialMessages'),
      trialPlans: this.num(p, 'trialPlans'),
    };
  }

  private householdJoined(p: Record<string, unknown>): HouseholdJoinedPayload {
    const raw = p.members;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('brak listy "members"');
    }
    const members = raw.map((entry, i) => {
      const member = entry as Record<string, unknown>;
      const name = member?.name;
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`domownik ${i} bez nazwy`);
      }
      const color = member?.avatarColor;
      return {
        name,
        avatarColor:
          typeof color === 'number' && Number.isFinite(color) ? color : null,
      };
    });
    return { householdName: this.str(p, 'householdName'), members };
  }

  private aiTrial(p: Record<string, unknown>): AiTrialExhaustedPayload {
    return {
      exhausted: this.counter(p, 'exhausted'),
      messagesUsed: this.num(p, 'messagesUsed'),
      messagesLimit: this.num(p, 'messagesLimit'),
      plansUsed: this.num(p, 'plansUsed'),
      plansLimit: this.num(p, 'plansLimit'),
    };
  }

  private aiQuota(p: Record<string, unknown>): AiQuotaExhaustedPayload {
    return {
      exhausted: this.counter(p, 'exhausted'),
      planName: this.str(p, 'planName'),
      isPayer: this.bool(p, 'isPayer'),
      payerName: this.strOrNull(p, 'payerName'),
      messagesUsed: this.num(p, 'messagesUsed'),
      messagesLimit: this.num(p, 'messagesLimit'),
      plansUsed: this.num(p, 'plansUsed'),
      plansLimit: this.num(p, 'plansLimit'),
      renewsAtIso: this.strOrNull(p, 'renewsAtIso'),
      renews: this.bool(p, 'renews'),
    };
  }

  private grace(p: Record<string, unknown>): SubscriptionGracePayload {
    return {
      planName: this.str(p, 'planName'),
      graceEndsAtIso: this.strOrNull(p, 'graceEndsAtIso'),
    };
  }

  private expired(p: Record<string, unknown>): SubscriptionExpiredPayload {
    return {
      planName: this.str(p, 'planName'),
      expiredAtIso: this.strOrNull(p, 'expiredAtIso'),
      revoked: this.bool(p, 'revoked'),
    };
  }

  private accountDeleted(p: Record<string, unknown>): AccountDeletedPayload {
    return {
      email: this.str(p, 'email'),
      deletedAtIso: this.str(p, 'deletedAtIso'),
      householdRemains: this.bool(p, 'householdRemains'),
      keptRecipes: this.num(p, 'keptRecipes'),
      hasLiveSubscription: this.bool(p, 'hasLiveSubscription'),
    };
  }

  private legalUpdate(p: Record<string, unknown>): LegalUpdatePayload {
    const raw = p.changes;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error('brak listy "changes"');
    }
    const changes = raw.map((entry, i) => {
      const change = entry as Record<string, unknown>;
      if (
        typeof change?.title !== 'string' ||
        typeof change?.body !== 'string'
      ) {
        throw new Error(`punkt zmian ${i} bez tytułu albo opisu`);
      }
      return { title: change.title, body: change.body };
    });
    return {
      effectiveDateIso: this.str(p, 'effectiveDateIso'),
      version: this.str(p, 'version'),
      requiresConsent: this.bool(p, 'requiresConsent'),
      changes,
    };
  }
}
