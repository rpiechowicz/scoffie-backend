import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailOutboxService } from '../mail/mail-outbox.service';
import {
  AiUsageCountersService,
  HouseholdPlan,
} from './ai-usage-counters.service';

/**
 * Mail o wyczerpanej puli asystenta (szablony C1 i C2).
 *
 * DLACZEGO OSOBNY SERWIS, A NIE DWA WYWOŁANIA W MIEJSCU RZUTU. Bo pula kończy
 * się w DWÓCH niezależnych licznikach i w dwóch różnych plikach: wiadomości
 * przy zakładaniu tury, zapisy planu przy zatwierdzaniu propozycji. Jedna
 * definicja zamiast dwóch kopii, które i tak by się rozjechały.
 *
 * MAIL WYCHODZI PO ODMOWIE, NIE PRZED NIĄ. Kwota schodzi wewnątrz transakcji,
 * a odmowa tę transakcję wycofuje — wiersz zakolejkowany w środku zniknąłby
 * razem z nią. Dlatego wołający robi to dopiero, gdy wyjątek już poleciał.
 *
 * NIGDY NIE RZUCA. Mail jest dodatkiem do odmowy 429, a nie jej częścią.
 */
@Injectable()
export class AgentQuotaMailService {
  private readonly logger = new Logger(AgentQuotaMailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counters: AiUsageCountersService,
    @Optional() private readonly mail?: MailOutboxService,
  ) {}

  async announce(
    userId: string,
    plan: HouseholdPlan,
    exhausted: 'messages' | 'plans',
  ): Promise<void> {
    if (!this.mail) return;
    try {
      await this.send(userId, plan, exhausted);
    } catch (error) {
      this.logger.warn(
        `nie udało się zakolejkować maila o kwocie: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async send(
    userId: string,
    plan: HouseholdPlan,
    exhausted: 'messages' | 'plans',
  ): Promise<void> {
    const person = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    if (!person?.email) return;

    const [messagesUsed, plansUsed] = await Promise.all([
      this.counters.read(plan.quotaScopeId, plan.periodKey, 'messages'),
      this.counters.read(plan.quotaScopeId, plan.periodKey, 'plans'),
    ]);

    if (plan.tier === 'TRIAL') {
      await this.mail?.enqueue(this.prisma, {
        template: 'AI_TRIAL_EXHAUSTED',
        // Pula próbna jest JEDNA NA ŻYCIE osoby, więc klucz nie potrzebuje
        // okresu — ale potrzebuje licznika: skończone wiadomości i skończony
        // zapis planu to dwa różne zdarzenia i dwa różne maile.
        dedupeKey: `trial-quota:${plan.quotaScopeId}:${exhausted}`,
        to: person.email,
        userId,
        payload: {
          exhausted,
          messagesUsed,
          messagesLimit: plan.messagesLimit,
          plansUsed,
          plansLimit: plan.plansLimit,
        },
      });
      return;
    }

    // Kto płaci. Pula wisi na UMOWIE, więc adresatem bywa domownik, który
    // niczego nie opłaca — treść i przycisk zależą właśnie od tego.
    let isPayer = false;
    let payerName: string | null = null;
    if (plan.subscriptionId) {
      const subscription = await this.prisma.subscription.findUnique({
        where: { id: plan.subscriptionId },
        select: {
          purchaserUserId: true,
          purchaser: { select: { displayName: true } },
        },
      });
      isPayer = subscription?.purchaserUserId === userId;
      payerName = subscription?.purchaser?.displayName ?? null;
    }

    await this.mail?.enqueue(this.prisma, {
      template: 'AI_QUOTA_EXHAUSTED',
      // Jeden mail na osobę na okres: pula jest wspólna, więc uderzyć w nią
      // może kilkoro domowników — i każde z nich chce wiedzieć, dlaczego
      // asystent milczy. Ale tylko raz.
      dedupeKey: `quota:${plan.quotaScopeId}:${plan.periodKey}:${userId}:${exhausted}`,
      to: person.email,
      userId,
      payload: {
        exhausted,
        planName: plan.product ?? 'Plan Scoffie',
        isPayer,
        payerName,
        messagesUsed,
        messagesLimit: plan.messagesLimit,
        plansUsed,
        plansLimit: plan.plansLimit,
        // `resetsAt` jest już tekstem ISO — kontrakt `HouseholdPlan`.
        renewsAtIso: plan.resetsAt,
        renews: plan.renews,
      },
    });
  }
}
