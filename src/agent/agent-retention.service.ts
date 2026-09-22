import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readAgentEnv, TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';

const daysAgo = (now: Date, days: number): Date =>
  new Date(now.getTime() - days * 86_400_000);
import { PrismaService } from '../prisma/prisma.service';

/** Sześć godzin: retencja liczona w dniach nie potrzebuje częściej. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Pierwszy przebieg po minucie — nie w trakcie startu i healthchecku. */
const FIRST_SWEEP_DELAY_MS = 60 * 1000;
/** Wygasłe, nieprzyjęte zaproszenia znikają po 30 dniach od wygaśnięcia. */
const INVITATION_GRACE_DAYS = 30;
/** Polityka §10: dane o użyciu asystenta „do 12 miesięcy". */
const AI_USAGE_DAYS = 365;
/** Zgłoszenia odpowiedzi — rok, tyle trzeba na rozpatrzenie i statystykę. */
const AGENT_REPORT_DAYS = 365;
/** Urządzenie push, które od 90 dni nie odpowiada, nie wróci. */
const DEAD_PUSH_DEVICE_DAYS = 90;
/**
 * Rozmowa bez ani jednej wiadomości znika po dobie od założenia. Doba, a nie
 * od razu: telefon trzyma identyfikator świeżo założonej rozmowy i wysyła do
 * niej pierwsze pytanie — skasowana pod nim dałaby 404. Klient i tak zaczyna
 * czystą kartkę po 30 minutach bezczynności, więc doba to duży zapas.
 */
const EMPTY_CONVERSATION_HOURS = 24;

export type RetentionSweep = {
  cutoff: string | null;
  conversations: number;
  emptyConversations: number;
  invitations: number;
  aiUsage: number;
  reports: number;
  refreshTokens: number;
  pushDevices: number;
};

/**
 * Automatyczna retencja — to, co polityka prywatności obiecuje, kod musi
 * robić sam. Rozmowy asystenta (z wiadomościami, turami, kartami i
 * propozycjami) znikają po `AI_CONVERSATION_RETENTION_DAYS` od ostatniej
 * wiadomości, a puste — po dobie od założenia; księga kosztów zostaje, bo `AiUsage.turnId` jest od 2.09
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
    // Niezależnie od retencji rozmów — obietnice z polityki §10 i porządki,
    // które nie mają własnej zmiennej.
    const aiUsage = await this.prisma.aiUsage.deleteMany({
      where: { createdAt: { lt: daysAgo(now, AI_USAGE_DAYS) } },
    });
    const reports = await this.prisma.agentReport.deleteMany({
      where: { createdAt: { lt: daysAgo(now, AGENT_REPORT_DAYS) } },
    });
    // Unieważnione tokeny zostają do `expiresAt`: wykrywanie ponownego
    // użycia (`auth.service`) opiera się na ZNALEZIENIU wiersza z `revokedAt`
    // — skasowany od razu zamieniał replay w zwykłe 401 bez odcięcia rodziny.
    const refreshTokens = await this.prisma.refreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const pushDevices = await this.prisma.pushDevice.deleteMany({
      where: {
        isActive: false,
        updatedAt: { lt: daysAgo(now, DEAD_PUSH_DEVICE_DAYS) },
      },
    });
    // Puste rozmowy nie niosą niczyich danych — nie ma czego trzymać, a na
    // liście historii to same „Nowa rozmowa · Bez wiadomości". Poza retencją
    // treści, więc `AI_CONVERSATION_RETENTION_DAYS=0` ich nie zatrzymuje.
    // `turns: none` zamiast samego „nic w biegu": tura bez wiadomości to
    // rozmowa, która coś robiła — tę oddajemy zwykłej retencji.
    const emptyConversations = await this.prisma.agentConversation.deleteMany({
      where: {
        createdAt: {
          lt: new Date(now.getTime() - EMPTY_CONVERSATION_HOURS * 3_600_000),
        },
        messages: { none: {} },
        turns: { none: {} },
      },
    });
    const extras = {
      emptyConversations: emptyConversations.count,
      aiUsage: aiUsage.count,
      reports: reports.count,
      refreshTokens: refreshTokens.count,
      pushDevices: pushDevices.count,
    };
    if (days <= 0) {
      return {
        cutoff: null,
        conversations: 0,
        invitations: invitations.count,
        ...extras,
      };
    }
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    // Tura-zombie (proces padł w połowie, nikt jej nie odpytał) nie może
    // trzymać rozmowy poza retencją na zawsze — domykamy ją tu tak samo
    // jak leniwy timeout w odczycie.
    const env = readAgentEnv();
    await this.prisma.agentTurn.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: {
          lt: new Date(
            now.getTime() - env.turnTimeoutMs - TURN_TIMEOUT_GRACE_MS,
          ),
        },
      },
      data: { status: 'FAILED', errorCode: 'AI_TIMEOUT', finishedAt: now },
    });
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
      ...extras,
    };
  }

  private async runQuietly(): Promise<void> {
    try {
      const result = await this.sweep();
      if (
        result.conversations > 0 ||
        result.emptyConversations > 0 ||
        result.invitations > 0
      ) {
        this.logger.log(
          `retencja: rozmowy ${result.conversations} (przed ${result.cutoff ?? '—'}), puste ${result.emptyConversations}, zaproszenia ${result.invitations}`,
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
