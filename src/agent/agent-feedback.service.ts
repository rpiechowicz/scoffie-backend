import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentFeedbackTag,
  AgentMessageRating,
  RateMessageDto,
} from './dto/rate-message.dto';

export type AgentFeedbackResult = {
  messageId: string;
  rating: AgentMessageRating | null;
  tags: AgentFeedbackTag[];
  comment: string | null;
};

/**
 * Kciuk w górę / w dół pod odpowiedzią asystenta (27.09.2026).
 *
 * Lżejsze od „Zgłoś odpowiedź": bez powodu z listy zgłoszeń i bez
 * powiadomienia panelu — to sygnał jakości, a nie sprawa do rozpatrzenia.
 * Jedna ocena na osobę i wiadomość; ta sama ocena drugi raz niczego nie
 * zmienia (idempotentnie), `null` ją zdejmuje. Jak zgłoszenie — bez
 * `assertEnabled`: ocenić można to, co się już dostało.
 *
 * Kciuk w dół może nieść PODPOWIEDŹ (powody + zdanie) — wtedy ocena zabiera
 * migawkę odpowiedzi, bo użytkownik sam wysyła ją do wglądu (jak przy
 * zgłoszeniu). Gołe kciuki treści nie niosą — tylko rodzaj odpowiedzi.
 */
@Injectable()
export class AgentFeedbackService {
  private readonly logger = new Logger(AgentFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async rate(
    userId: string,
    messageId: string,
    input: RateMessageDto,
  ): Promise<AgentFeedbackResult> {
    assertUuid(messageId, 'messageId');
    const dto = await validateDto(RateMessageDto, input);

    // Własność przez rozmowę, jak przy zgłoszeniu: cudza wiadomość = 404.
    // Ocenia się tylko odpowiedzi asystenta.
    const message = await this.prisma.agentMessage.findFirst({
      where: {
        id: messageId,
        role: 'ASSISTANT',
        conversation: { userId },
      },
      select: { id: true, turnId: true, kind: true, text: true },
    });
    if (!message) {
      throw new AppException(
        'AI_MESSAGE_NOT_FOUND',
        'Nie znaleziono odpowiedzi do oceny.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (dto.rating === null) {
      await this.prisma.agentMessageFeedback.deleteMany({
        where: { userId, messageId: message.id },
      });
      this.log(message.id, message.turnId, 'zdjęta');
      return { messageId: message.id, rating: null, tags: [], comment: null };
    }

    const note = noteFor(dto);
    // Pochwała i zmiana na „w górę” czyszczą podpowiedź; kciuk w dół BEZ
    // pól podpowiedzi zostawia tę, którą ktoś już napisał.
    const noteData =
      dto.rating === 'UP'
        ? { tags: [], comment: null, messageText: null }
        : note
          ? {
              tags: note.tags,
              comment: note.comment,
              messageText:
                note.tags.length > 0 || note.comment ? message.text : null,
            }
          : undefined;

    const saved = await this.prisma.agentMessageFeedback.upsert({
      where: { userId_messageId: { userId, messageId: message.id } },
      create: {
        userId,
        messageId: message.id,
        turnId: message.turnId,
        rating: dto.rating,
        messageKind: message.kind,
        ...(noteData ?? {}),
      },
      update: { rating: dto.rating, ...(noteData ?? {}) },
      select: { rating: true, tags: true, comment: true },
    });
    this.log(
      message.id,
      message.turnId,
      `${saved.rating}${saved.tags.length > 0 || saved.comment ? ' z podpowiedzią' : ''}`,
    );
    return {
      messageId: message.id,
      rating: saved.rating as AgentMessageRating,
      tags: saved.tags as AgentFeedbackTag[],
      comment: saved.comment,
    };
  }

  // Same identyfikatory i ocena — bez treści (jak zgłoszenia).
  private log(messageId: string, turnId: string | null, what: string): void {
    this.logger.log(
      `ocena odpowiedzi asystenta: message=${messageId} turn=${turnId ?? '-'} ocena=${what}`,
    );
  }
}

/** Podpowiedź z żądania; `null` = żądanie jej nie niesie (sam kciuk). */
function noteFor(
  dto: RateMessageDto,
): { tags: AgentFeedbackTag[]; comment: string | null } | null {
  if (dto.tags === undefined && dto.comment === undefined) return null;
  const comment = dto.comment?.trim() ?? '';
  return {
    tags: [...new Set(dto.tags ?? [])],
    comment: comment ? comment : null,
  };
}
