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
import { AgentTurnsService } from './agent-turns.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { PostMessageDto } from './dto/post-message.dto';

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
  ) {}

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

  @Get('turns/:id')
  @Throttle({
    default: { limit: () => readThrottleLimit('THROTTLE_AGENT_POLL_LIMIT') },
  })
  getTurn(@CurrentUserId() userId: string, @Param('id') turnId: string) {
    return this.turns.getTurn(userId, turnId);
  }

  /** RODO: „usuń moje rozmowy z asystentem". Działa też przy `AI_ENABLED=false`. */
  @Delete('conversations')
  deleteConversations(@CurrentUserId() userId: string) {
    return this.conversations.deleteAll(userId);
  }
}
