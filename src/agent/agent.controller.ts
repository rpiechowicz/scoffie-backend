import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { CurrentUserId } from '../auth/current-user-id.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestId } from '../common/request-id.decorator';
import { readThrottleLimit } from '../common/throttle/throttle-env';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentReportsService } from './agent-reports.service';
import { AgentUsageService } from './agent-usage.service';
import { MemoryQueryDto } from './dto/memory-query.dto';
import { UsageQueryDto } from './dto/usage-query.dto';
import { ReportMessageDto } from './dto/report-message.dto';
import { AgentTurnsService } from './agent-turns.service';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { EditMessageDto, PostMessageDto } from './dto/post-message.dto';

/**
 * Asystent po REST z JWT — nie po Socket.IO.
 *
 * Cała domena jedzie u nas socketem, ale tura asystenta jest inna: trwa
 * dziesiątki sekund, kosztuje pieniądze i musi przeżyć telefon wchodzący w
 * tło. Stąd `202 Accepted` + `Location`, a stan tury z `GET /agent/turns/:id`.
 * Klient odpytuje co ~1 s; limit pollingu jest osobny i luźniejszy niż limit
 * wysyłki (`THROTTLE_AGENT_POLL_LIMIT` vs `THROTTLE_AGENT_MESSAGE_LIMIT`),
 * żeby czekanie na własną turę nie kończyło się 429.
 */
@ApiTags('agent')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('agent')
export class AgentController {
  constructor(
    private readonly conversations: AgentConversationsService,
    private readonly turns: AgentTurnsService,
    private readonly memory: AgentMemoryService,
    private readonly proposals: AgentProposalsService,
    private readonly reports: AgentReportsService,
    private readonly usageService: AgentUsageService,
  ) {}

  /**
   * „Ile mi zostało" — zużycie i limity miesiąca dla gospodarstwa oraz data
   * odnowienia. Bez `assertEnabled`: liczby są prawdziwe także przy
   * wyłączonym asystencie. Limit pollingu: telefon odświeża to przy każdym
   * otwarciu zakładki.
   */
  @Get('usage')
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_POLL_LIMIT') },
  })
  usage(@CurrentUserId() userId: string, @Query() query: UsageQueryDto) {
    return this.usageService.usage(userId, query.householdId);
  }

  /**
   * „Zgłoś odpowiedź" — bez `assertEnabled`: zgłosić można to, co się już
   * dostało, także gdy asystent jest akurat wyłączony.
   */
  @Post('messages/:id/report')
  @HttpCode(HttpStatus.CREATED)
  reportMessage(
    @CurrentUserId() userId: string,
    @Param('id') messageId: string,
    @Body() dto: ReportMessageDto,
  ) {
    return this.reports.report(userId, messageId, dto);
  }

  @Post('conversations')
  createConversation(
    @CurrentUserId() userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(userId, dto);
  }

  @Get('conversations')
  listConversations(@CurrentUserId() userId: string) {
    return this.conversations.list(userId);
  }

  @Get('conversations/:id/messages')
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_POLL_LIMIT') },
  })
  listMessages(
    @CurrentUserId() userId: string,
    @Param('id') conversationId: string,
    @Query() query: ListMessagesQueryDto,
  ) {
    return this.conversations.messages(userId, conversationId, query);
  }

  /**
   * Przyjmuje wiadomość i oddaje 202 z identyfikatorem tury — odpowiedź
   * asystenta przychodzi dopiero przez polling. `Location` wskazuje turę,
   * żeby klient nie sklejał adresu sam.
   */
  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT') },
  })
  async postMessage(
    @CurrentUserId() userId: string,
    @Param('id') conversationId: string,
    @Body() dto: PostMessageDto,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const accepted = await this.turns.postMessage(
      userId,
      conversationId,
      dto,
      requestId,
    );
    res.setHeader('Location', `/agent/turns/${accepted.turnId}`);
    return accepted;
  }

  /**
   * Poprawienie własnego pytania — nowa tura zamiast edycji w miejscu.
   *
   * Ta sama trasa co wysyłka (202 + `Location`), bo z punktu widzenia klienta
   * to jest wysłanie wiadomości; różnica jest w tym, co znika z rozmowy.
   */
  @Post('conversations/:id/messages/edit')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT') },
  })
  async editMessage(
    @CurrentUserId() userId: string,
    @Param('id') conversationId: string,
    @Body() dto: EditMessageDto,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const accepted = await this.turns.editMessage(
      userId,
      conversationId,
      dto,
      requestId,
    );
    res.setHeader('Location', `/agent/turns/${accepted.turnId}`);
    return accepted;
  }

  @Get('turns/:id')
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_POLL_LIMIT') },
  })
  getTurn(@CurrentUserId() userId: string, @Param('id') turnId: string) {
    return this.turns.getTurn(userId, turnId);
  }

  /**
   * Zatwierdzenie propozycji — moment, w którym plan naprawdę się zmienia.
   *
   * Bez ciała: jednostką idempotencji jest sama propozycja, więc drugie
   * kliknięcie dostaje ten sam wynik (200), a nie konflikt. Nie ma tu udziału
   * modelu, więc operacja nie kosztuje ani jednego tokenu — i dlatego celowo
   * NIE sprawdzamy `AI_ENABLED`: karta jest już na ekranie, a wyłączenie
   * asystenta w międzyczasie nie może zostawić martwego przycisku.
   */
  @Post('proposals/:id/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT') },
  })
  applyProposal(
    @CurrentUserId() userId: string,
    @Param('id') proposalId: string,
  ) {
    return this.proposals.apply(userId, proposalId);
  }

  /** Cofnięcie zapisu — okno czasowe i bramka na cudze zmiany w serwisie. */
  @Post('proposals/:id/undo')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_MESSAGE_LIMIT') },
  })
  undoProposal(
    @CurrentUserId() userId: string,
    @Param('id') proposalId: string,
  ) {
    return this.proposals.undo(userId, proposalId);
  }

  /** RODO: „usuń moje rozmowy z asystentem". Działa też przy `AI_ENABLED=false`. */
  @Delete('conversations')
  deleteConversations(@CurrentUserId() userId: string) {
    return this.conversations.deleteAll(userId);
  }

  /**
   * Co asystent pamięta o tym domu — do pokazania i skasowania w aplikacji.
   *
   * Pamięć jest wspólna dla gospodarstwa, więc widzi ją każdy domownik. Bez
   * tego ekranu byłaby to pamięć, o której użytkownik wie tylko stąd, że
   * asystent nagle coś „wie" — a tego się nie da ani sprawdzić, ani cofnąć.
   */
  @Get('memory')
  listMemory(@CurrentUserId() userId: string, @Query() query: MemoryQueryDto) {
    return this.memory.listForUser(userId, query.householdId);
  }

  @Delete('memory/:id')
  forgetMemory(@CurrentUserId() userId: string, @Param('id') noteId: string) {
    return this.memory.forget(userId, noteId);
  }

  /** Porządki na liście rozmów — jedna pozycja, nie całość. */
  @Delete('conversations/:id')
  deleteConversation(
    @CurrentUserId() userId: string,
    @Param('id') conversationId: string,
  ) {
    return this.conversations.deleteOne(userId, conversationId);
  }
}
