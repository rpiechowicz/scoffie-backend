import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
import { PrismaService } from '../prisma/prisma.service';

/** Sześć godzin: retencja liczona w dniach nie potrzebuje częściej. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Pierwszy przebieg po minucie — nie w trakcie startu i healthchecku. */
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
/** Wygasłe, nieprzyjęte zaproszenia znikają po 30 dniach od wygaśnięcia. */
const INVITATION_GRACE_DAYS = 30;

export type RetentionSweep = {
  cutoff: string | null;
  conversations: number;
  invitations: number;
};

/**
 * Automatyczna retencja — to, co polityka prywatności obiecuje, kod musi
 * robić sam. Rozmowy asystenta (z wiadomościami, turami, kartami i
 * propozycjami) znikają po `AI_CONVERSATION_RETENTION_DAYS` od ostatniej
 * wiadomości; księga kosztów zostaje, bo `AiUsage.turnId` jest od 2.09
 * `SetNull`. Przy okazji znikają zaproszenia, które wygasły ponad miesiąc
 * temu i nikt ich nie przyjął.
 *
 * Jedna instancja Railway, więc zwykły `setInterval` (z `unref`, żeby nie
 * trzymał procesu) zamiast kolejki czy crona. Rozmowa z turą w biegu jest
 * omijana — nie kasujemy nikomu tury, za którą właśnie płaci.
 */
@Injectable()
export class AgentRetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentRetentionService.name);
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    // Testy (jest) bootują AppModule dziesiątki razy; timery z `unref` nie
    // trzymają procesu, a `onModuleDestroy` je sprząta przy `app.close()`.
    this.first = setTimeout(() => void this.runQuietly(), FIRST_SWEEP_DELAY_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.runQuietly(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<RetentionSweep> {
    const days = readAgentEnv().conversationRetentionDays;
    const invitations = await this.prisma.invitation.deleteMany({
      where: {
        redeemedAt: null,
        expiresAt: {
          lt: new Date(now.getTime() - INVITATION_GRACE_DAYS * 86_400_000),
        },
      },
    });
    if (days <= 0) {
      return { cutoff: null, conversations: 0, invitations: invitations.count };
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const conversations = await this.prisma.agentConversation.deleteMany({
      where: {
        // Ostatnia wiadomość, a gdy rozmowa nigdy jej nie dostała — założenie.
        OR: [
          { lastMessageAt: { lt: cutoff } },
          { lastMessageAt: null, createdAt: { lt: cutoff } },
        ],
        turns: { none: { status: 'RUNNING' } },
      },
    });
    return {
      cutoff: cutoff.toISOString(),
      conversations: conversations.count,
      invitations: invitations.count,
    };
  }

  private async runQuietly(): Promise<void> {
    try {
      const result = await this.sweep();
      if (result.conversations > 0 || result.invitations > 0) {
        this.logger.log(
          `retencja: rozmowy ${result.conversations} (przed ${result.cutoff ?? '—'}), zaproszenia ${result.invitations}`,
        );
      }
    } catch (error) {
      // Porządki nie mogą położyć procesu ani zalać logów — jedna linia,
      // następny przebieg za sześć godzin.
      this.logger.warn(
        `retencja nie powiodła się: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
