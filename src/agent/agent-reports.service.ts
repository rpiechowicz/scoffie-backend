import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { emitLive } from '../common/live-events';
import { PrismaService } from '../prisma/prisma.service';
import { ReportMessageDto } from './dto/report-message.dto';

/** Migawka treści zgłaszanej wiadomości — tyle, ile potrzeba do rozpatrzenia. */
const SNAPSHOT_LIMIT = 4000;

/**
 * „Zgłoś odpowiedź" — mechanizm zgłaszania treści generowanych (App Store
 * 1.2 / 4.7). Działa niezależnie od `AI_ENABLED`: użytkownik ma prawo zgłosić
 * to, co już dostał, także gdy asystent jest akurat wyłączony.
 *
 * Zgłoszenie niesie MIGAWKĘ treści: retencja kasuje rozmowy po 90 dniach,
 * a zgłoszenie bez treści nie da się rozpatrzyć. Do logów idą tylko
 * identyfikatory i powód — nie treść.
 */
const REPORT_REASON_LABELS: Record<string, string> = {
  WRONG: 'Powód: błąd merytoryczny',
  UNSAFE: 'Powód: szkodliwa dla zdrowia',
  OFFENSIVE: 'Powód: obraźliwa lub nie na temat',
  OTHER: 'Powód: inny',
};

@Injectable()
export class AgentReportsService {
  private readonly logger = new Logger(AgentReportsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async report(
    userId: string,
    messageId: string,
    input: ReportMessageDto,
  ): Promise<{ id: string; createdAt: string }> {
    assertUuid(messageId, 'messageId');
    const dto = await validateDto(ReportMessageDto, input);

    // Własność przez rozmowę: cudza wiadomość = 404, nie 403 (nie zdradzamy
    // istnienia). Zgłaszać można tylko odpowiedzi asystenta — własnych pytań
    // nie ma po co.
    const message = await this.prisma.agentMessage.findFirst({
      where: {
        id: messageId,
        role: 'ASSISTANT',
        conversation: { userId },
      },
      select: { id: true, conversationId: true, turnId: true, text: true },
    });
    if (!message) {
      throw new AppException(
        'AI_MESSAGE_NOT_FOUND',
        'Nie znaleziono odpowiedzi do zgłoszenia.',
        HttpStatus.NOT_FOUND,
      );
    }

    const report = await this.prisma.agentReport.create({
      data: {
        userId,
        conversationId: message.conversationId,
        messageId: message.id,
        turnId: message.turnId,
        reason: dto.reason,
        comment: dto.comment?.trim() || null,
        messageText: message.text.slice(0, SNAPSHOT_LIMIT),
      },
      select: { id: true, createdAt: true },
    });
    this.logger.warn(
      `zgłoszenie odpowiedzi asystenta: report=${report.id} message=${message.id} turn=${message.turnId ?? '-'} powód=${dto.reason}`,
    );
    // Panel: badge zgłoszeń + powiadomienie. Sam powód — bez treści
    // odpowiedzi i komentarza (te panel pobierze REST-em).
    emitLive({
      topics: ['reports'],
      notice: {
        level: dto.reason === 'UNSAFE' ? 'error' : 'warning',
        title: 'Nowe zgłoszenie odpowiedzi asystenta',
        body: REPORT_REASON_LABELS[dto.reason] ?? dto.reason,
        link: '/reports',
        topic: 'reports',
      },
    });
    return { id: report.id, createdAt: report.createdAt.toISOString() };
  }
}
