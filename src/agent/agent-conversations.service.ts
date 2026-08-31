import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConfigService } from './agent-config.service';
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
};

export type MessageView = {
  id: string;
  role: string;
  kind: string;
  text: string;
  clientMessageId: string | null;
  turnId: string | null;
  createdAt: string;
};

/** Ile wiadomości oddaje jeden odczyt historii (klient dobiera kursorem `after`). */
export const MESSAGES_PAGE_SIZE = 100;

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

  async list(userId: string): Promise<ConversationView[]> {
    this.config.assertEnabled();
    const conversations = await this.prisma.agentConversation.findMany({
      where: { userId },
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
    });
    return conversations.map((c) => this.toConversationView(c));
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

    return {
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        kind: m.kind,
        text: m.text,
        clientMessageId: m.clientMessageId,
        turnId: m.turnId,
        createdAt: m.createdAt.toISOString(),
      })),
    };
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
