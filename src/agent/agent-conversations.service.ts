import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
import { AgentConfigService } from './agent-config.service';
import { AgentCard } from './cards/agent-cards';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';

export type OwnedConversation = {
  id: string;
  userId: string;
  householdId: string;
  status: string;
};

export type ConversationView = {
  id: string;
  householdId: string;
  status: string;
  title: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  /**
   * Początek ostatniej wiadomości — lista rozmów bez tego to lista dat.
   * Przycięty na serwerze, bo klient i tak pokaże jedną linijkę, a odpowiedź
   * asystenta potrafi mieć dwa tysiące znaków.
   */
  preview?: string | null;
  /**
   * Tura, która JESZCZE BIEGNIE w tej rozmowie.
   *
   * Bez tego pola identyfikator biegnącej tury żyje wyłącznie w pamięci
   * telefonu: wystarczy zamknąć aplikację albo przełączyć rozmowę, żeby
   * użytkownik został z własnym pytaniem bez odpowiedzi i bez sposobu, by do
   * niej wrócić. Klient, który dostaje `activeTurnId`, wraca do odpytywania —
   * a to samo w sobie domyka turę-zombie przez `expireIfStale`.
   */
  activeTurnId?: string | null;
};

/** Ile znaków ostatniej wiadomości trafia na listę rozmów. */
export const CONVERSATION_PREVIEW_MAX = 120;

export type MessageView = {
  id: string;
  role: string;
  kind: string;
  text: string;
  clientMessageId: string | null;
  turnId: string | null;
  createdAt: string;
  /**
   * Treść strukturalna — `null` dla zwykłego `TEXT`.
   *
   * `text` broni się sam także wtedy, gdy karta jest: klient, który jej nie
   * zna, ma pokazać zdanie i niczego nie stracić.
   */
  card?: AgentCard | null;
};

/** Ile wiadomości oddaje jeden odczyt historii (klient dobiera kursorem `after`). */
export const MESSAGES_PAGE_SIZE = 100;

/**
 * Ile rozmów wraca na liście historii.
 *
 * `findMany` bez limitu po pół roku oddawałoby setki rozmów z podglądem
 * każdej — a użytkownik i tak sięga do kilku ostatnich.
 */
export const CONVERSATIONS_PAGE_SIZE = 50;

/** Ile znaków pierwszej wiadomości trafia do tytułu rozmowy. */
export const CONVERSATION_TITLE_MAX = 60;

/**
 * Tytuł rozmowy z PIERWSZEJ wiadomości użytkownika.
 *
 * Bez tego lista rozmów w telefonie to same daty — pole `title` istniało od
 * Fazy 0 i zawsze wracało puste. Tytuł liczy się TUTAJ, a nie modelem: druga
 * tura tylko po to, żeby nazwać rozmowę, kosztowałaby tyle, co ułożenie
 * dwóch kolacji, i musiałaby czekać na odpowiedź, zanim lista się odświeży.
 *
 * Ucinamy na granicy słowa — „Zaplanuj mi tydzień bezglutenowy dla dwóch…"
 * czyta się, a „…dla dwó…" nie.
 */
export function conversationTitleFrom(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  if (clean.length <= CONVERSATION_TITLE_MAX) return clean;
  const cut = clean.slice(0, CONVERSATION_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // Jedno bardzo długie słowo (wklejony link) nie ma granicy — tnij twardo.
  const base =
    lastSpace > CONVERSATION_TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

/**
 * Rozmowy asystenta: zakładanie, lista, historia wiadomości, kasowanie.
 *
 * Rozmowa należy do JEDNEJ osoby (`userId`) i jest przypięta do gospodarstwa
 * (`householdId`). Domownicy nie widzą swoich rozmów nawzajem — asystent zna
 * preferencje, cele i wagę pytającego; wspólny jest plan tygodnia, nie czat.
 * Kwota za to jest wspólna (licznik po `householdId`), bo subskrypcja idzie
 * per dom (decyzja domyślna — patrz „Decyzje, które czekają na Rafała").
 *
 * Walidacja jest w serwisie, nie tylko na pipie kontrolera: te same metody
 * zawoła w Fazie 1 asystent in-process, a wtedy żaden pipe nie biegnie.
 */
@Injectable()
export class AgentConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AgentConfigService,
    // Stan kart liczy się przy odczycie, więc historia musi umieć o niego
    // zapytać — inaczej przycisk „Dodaj do planu" żyłby wiecznie.
    private readonly proposals: AgentProposalsService,
  ) {}

  async create(userId: string, dto: CreateConversationDto) {
    this.config.assertEnabled();
    const data = await validateDto(CreateConversationDto, dto);
    await this.ensureMembership(userId, data.householdId);

    const conversation = await this.prisma.agentConversation.create({
      data: { userId, householdId: data.householdId },
    });
    return this.toConversationView(conversation);
  }

  /**
   * Lista rozmów użytkownika, od najświeższej.
   *
   * Podgląd ostatniej wiadomości leci OSOBNYM zapytaniem z `DISTINCT ON`, a nie
   * zagnieżdżonym `include`. Powód jest zmierzony, nie estetyczny: Prisma przy
   * zagnieżdżonym `take: 1` dla WIĘCEJ NIŻ JEDNEGO rodzica usuwa `LIMIT`
   * z zapytania i przycina wynik dopiero w pamięci Node — czyli po drucie
   * leciałaby PEŁNA treść wszystkich wiadomości wszystkich rozmów, a odpowiedź
   * asystenta ma po dwa tysiące znaków. `DISTINCT ON` bierze dokładnie jeden
   * wiersz na rozmowę, po stronie bazy.
   */
  async list(userId: string): Promise<ConversationView[]> {
    this.config.assertEnabled();
    const conversations = await this.prisma.agentConversation.findMany({
      where: { userId },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: CONVERSATIONS_PAGE_SIZE,
      include: {
        // Tura w biegu, ale TYLKO żywa: martwa (po padzie procesu) pokazywałaby
        // się klientowi jako biegnąca, a on odpytywałby ją bez końca.
        turns: {
          where: {
            status: 'RUNNING',
            startedAt: { gt: this.staleTurnThreshold() },
          },
          orderBy: { startedAt: 'desc' },
          take: 1,
          select: { id: true },
        },
      },
    });
    if (conversations.length === 0) return [];

    const previews = await this.previews(conversations.map((c) => c.id));
    return conversations.map((conversation) => ({
      ...this.toConversationView(conversation),
      preview: previews.get(conversation.id) ?? null,
      activeTurnId: conversation.turns[0]?.id ?? null,
    }));
  }

  /** Ostatnia wiadomość każdej rozmowy — jeden wiersz na rozmowę, z bazy. */
  private async previews(ids: string[]): Promise<Map<string, string>> {
    const rows = await this.prisma.$queryRaw<
      { conversationId: string; text: string }[]
    >`
      SELECT DISTINCT ON ("conversationId") "conversationId", "text"
      FROM "AgentMessage"
      WHERE "conversationId" = ANY(${ids}::uuid[])
      ORDER BY "conversationId", "createdAt" DESC, "id" DESC
    `;
    const map = new Map<string, string>();
    for (const row of rows) {
      const preview = this.preview(row.text);
      if (preview) map.set(row.conversationId, preview);
    }
    return map;
  }

  /**
   * Granica „tura już nie żyje" — ta sama, co przy leniwym domknięciu tury
   * i przy lease. Trzy miejsca muszą mieć jedną definicję, inaczej lista
   * pokazuje jako biegnące coś, czego wysyłka już nie liczy.
   */
  private staleTurnThreshold(): Date {
    return new Date(
      Date.now() - this.config.read().turnTimeoutMs - TURN_TIMEOUT_GRACE_MS,
    );
  }

  private preview(text: string | undefined): string | null {
    if (!text) return null;
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= CONVERSATION_PREVIEW_MAX) return flat;
    return `${flat.slice(0, CONVERSATION_PREVIEW_MAX).trimEnd()}…`;
  }

  async messages(
    userId: string,
    conversationId: string,
    query: ListMessagesQueryDto,
  ): Promise<{ messages: MessageView[] }> {
    this.config.assertEnabled();
    const params = await validateDto(ListMessagesQueryDto, query);
    await this.loadOwned(userId, conversationId);

    // Kursor to id, nie znacznik czasu: dwie wiadomości tej samej tury
    // (pytanie i odpowiedź) potrafią mieć ten sam `createdAt` co do
    // milisekundy, a wtedy filtr po czasie gubiłby jedną z nich.
    let after: { createdAt: Date; id: string } | null = null;
    if (params.after) {
      const cursor = await this.prisma.agentMessage.findFirst({
        where: { id: params.after, conversationId },
        select: { id: true, createdAt: true },
      });
      if (!cursor) {
        throw new AppException(
          'AI_CONVERSATION_NOT_FOUND',
          'Nie znaleziono wiadomości, od której miała ruszyć historia.',
          HttpStatus.NOT_FOUND,
          ['after'],
        );
      }
      after = cursor;
    }

    const messages = await this.prisma.agentMessage.findMany({
      where: {
        conversationId,
        ...(after
          ? {
              OR: [
                { createdAt: { gt: after.createdAt } },
                { createdAt: after.createdAt, id: { gt: after.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MESSAGES_PAGE_SIZE,
    });

    const views: MessageView[] = messages.map((m) => ({
      id: m.id,
      role: m.role,
      kind: m.kind,
      text: m.text,
      clientMessageId: m.clientMessageId,
      turnId: m.turnId,
      createdAt: m.createdAt.toISOString(),
      card: (m.card ?? null) as AgentCard | null,
    }));

    return { messages: await this.proposals.withCardState(views) };
  }

  /**
   * Kasuje WSZYSTKIE rozmowy użytkownika (RODO — „usuń moje rozmowy z
   * asystentem"). Wiadomości, tury i wpisy `AiUsage` idą kaskadą; liczniki
   * kwot zostają, bo to dane rozliczeniowe gospodarstwa, nie treść rozmowy.
   *
   * Bez `assertEnabled`: prawo do usunięcia danych nie może zależeć od tego,
   * czy funkcja jest akurat włączona.
   */
  async deleteAll(userId: string): Promise<{ deleted: number }> {
    const result = await this.prisma.agentConversation.deleteMany({
      where: { userId },
    });
    return { deleted: result.count };
  }

  /**
   * Kasuje JEDNĄ rozmowę — porządki, nie RODO.
   *
   * Bez `assertEnabled` z tego samego powodu co `deleteAll`: sprzątanie
   * własnych danych nie może zależeć od tego, czy funkcja jest włączona.
   * Cudza rozmowa daje 404 (`loadOwned`), a nie 403.
   */
  async deleteOne(
    userId: string,
    conversationId: string,
  ): Promise<{ deleted: number }> {
    await this.loadOwned(userId, conversationId);
    const result = await this.prisma.agentConversation.deleteMany({
      where: { id: conversationId, userId },
    });
    return { deleted: result.count };
  }

  /**
   * Rozmowa wołającego albo 404. Cudza rozmowa daje ten sam błąd co
   * nieistniejąca — inaczej `GET` po kolejnych UUID mówiłby, które istnieją.
   */
  async loadOwned(
    userId: string,
    conversationId: string,
  ): Promise<OwnedConversation> {
    assertUuid(conversationId, 'conversationId');
    const conversation = await this.prisma.agentConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true, userId: true, householdId: true, status: true },
    });
    if (!conversation) {
      throw new AppException(
        'AI_CONVERSATION_NOT_FOUND',
        'Nie znaleziono tej rozmowy.',
        HttpStatus.NOT_FOUND,
      );
    }
    return conversation;
  }

  /** Ta sama bramka co w domenie: członkostwo, nie samo istnienie domu. */
  async ensureMembership(userId: string, householdId: string): Promise<void> {
    assertUuid(householdId, 'householdId');
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
      select: { userId: true },
    });
    if (!membership) {
      throw new AppException(
        'NOT_HOUSEHOLD_MEMBER',
        'User is not a member of this household',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private toConversationView(conversation: {
    id: string;
    householdId: string;
    status: string;
    title: string | null;
    lastMessageAt: Date | null;
    createdAt: Date;
  }): ConversationView {
    return {
      id: conversation.id,
      householdId: conversation.householdId,
      status: conversation.status,
      title: conversation.title,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      createdAt: conversation.createdAt.toISOString(),
    };
  }
}
