import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { AgentMessageRating, RateMessageDto } from './dto/rate-message.dto';

/**
 * Kciuk w górę / w dół pod odpowiedzią asystenta (27.09.2026).
 *
 * Lżejsze od „Zgłoś odpowiedź": bez powodu, bez migawki treści i bez
 * powiadomienia panelu — to sygnał jakości, a nie sprawa do rozpatrzenia.
 * Jedna ocena na osobę i wiadomość; ta sama ocena drugi raz niczego nie
 * zmienia (idempotentnie), `null` ją zdejmuje. Jak zgłoszenie — bez
 * `assertEnabled`: ocenić można to, co się już dostało.
 */
@Injectable()
export class AgentFeedbackService {
  private readonly logger = new Logger(AgentFeedbackService.name);

  constructor(private readonly prisma: PrismaService) {}

  async rate(
    userId: string,
    messageId: string,
    input: RateMessageDto,
  ): Promise<{ messageId: string; rating: AgentMessageRating | null }> {
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
      select: { id: true, turnId: true },
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
    } else {
      await this.prisma.agentMessageFeedback.upsert({
        where: { userId_messageId: { userId, messageId: message.id } },
        create: {
          userId,
          messageId: message.id,
          turnId: message.turnId,
          rating: dto.rating,
        },
        update: { rating: dto.rating },
      });
    }
    // Same identyfikatory i ocena — bez treści (jak zgłoszenia).
    this.logger.log(
      `ocena odpowiedzi asystenta: message=${message.id} turn=${message.turnId ?? '-'} ocena=${dto.rating ?? 'zdjęta'}`,
    );
    return { messageId: message.id, rating: dto.rating };
  }
}
