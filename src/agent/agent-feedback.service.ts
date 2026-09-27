import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentFeedbackTag,
  AgentMessageRating,
  feedbackTagsFor,
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
 * Ocena może nieść PODPOWIEDŹ (powody + zdanie) — w dół „co nie zagrało”,
 * w górę „co było dobre” (każdy kierunek ma swoje powody). Wtedy ocena
 * zabiera migawkę odpowiedzi, bo użytkownik sam wysyła ją do wglądu (jak przy
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
    // Ocenia się tylko odpowiedzi MODELU (z turą) — potwierdzenia zapisu
    // i cofnięcia serwer pisze bez `turnId` i telefon nie daje pod nimi
    // kciuków (27.09.2026: „nie pod każdą”).
    const message = await this.prisma.agentMessage.findFirst({
      where: {
        id: messageId,
        role: 'ASSISTANT',
        turnId: { not: null },
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

    const rating = dto.rating;
    const note = noteFor(dto);
    let noteData:
      | { tags: string[]; comment: string | null; messageText: string | null }
      | undefined;
    if (note) {
      const allowed = feedbackTagsFor(rating);
      const tags = note.tags.filter((tag) => allowed.includes(tag));
      noteData = {
        tags,
        comment: note.comment,
        messageText: tags.length > 0 || note.comment ? message.text : null,
      };
    } else {
      // Sam kciuk: podpowiedź zostaje przy tym samym kierunku, a przy zmianie
      // kierunku znika — „co nie zagrało” nie może wisieć pod pochwałą.
      const existing = await this.prisma.agentMessageFeedback.findUnique({
        where: { userId_messageId: { userId, messageId: message.id } },
        select: { rating: true },
      });
      if (existing && existing.rating !== rating) {
        noteData = { tags: [], comment: null, messageText: null };
      }
    }

    const saved = await this.prisma.agentMessageFeedback.upsert({
      where: { userId_messageId: { userId, messageId: message.id } },
      create: {
        userId,
        messageId: message.id,
        turnId: message.turnId,
        rating,
        messageKind: message.kind,
        ...(noteData ?? {}),
      },
      update: { rating, ...(noteData ?? {}) },
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
