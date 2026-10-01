import Anthropic from '@anthropic-ai/sdk';
import {
  capabilitiesFor,
  THINKING_BUDGET_TOKENS,
} from '../../../config/model-capabilities';
import { priceFor } from '../../../config/model-prices';
import type {
  WriterModel,
  WriterModelCall,
  WriterModelResult,
} from './writer.types';

/** Odczyt z cache 0,1× wejścia, zapis 5-minutowy 1,25× (cennik Anthropic). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;
/** Batch API: każda pozycja rachunku za pół ceny. */
export const BATCH_PRICE_MULTIPLIER = 0.5;

/**
 * Parametry żądania — WSPÓLNE dla wywołania na żywo i pozycji paczki
 * (Batch API przyjmuje dokładnie te same `params`), więc oba tryby piszą
 * z tym samym promptem, schematem i myśleniem.
 *
 * - `system` (zasady + wzorzec) z `cache_control` — przy serii przepisów
 *   płacimy za niego raz na kilka minut, nie za każdy przepis;
 * - `output_config.format` = JSON Schema — odpowiedź zawsze parsowalna,
 *   a braki treści łapią walidatory;
 * - myślenie w kształcie, który przyjmuje dany model (`model-capabilities`),
 *   bo zły kształt to 400, nie gorsza odpowiedź.
 */
export function messageParams(
  call: WriterModelCall,
): Anthropic.MessageCreateParamsNonStreaming {
  const caps = capabilitiesFor(call.model);
  const budget = THINKING_BUDGET_TOKENS[call.effort];
  const thinking: Anthropic.MessageCreateParams['thinking'] =
    caps.thinking === 'adaptive'
      ? { type: 'adaptive' }
      : budget
        ? { type: 'enabled', budget_tokens: budget }
        : undefined;
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    system: [
      { type: 'text', text: call.system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: call.user }],
    ...(thinking ? { thinking } : {}),
    output_config: {
      ...(caps.effort ? { effort: call.effort } : {}),
      format: { type: 'json_schema', schema: call.schema },
    },
  };
}

/** Odpowiedź API → wynik dla zadania (JSON, powód końca, koszt). */
export function resultFromMessage(
  model: string,
  response: Anthropic.Message,
  priceMultiplier = 1,
): WriterModelResult {
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const usage = response.usage;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const price = priceFor(model);
  return {
    json,
    stopReason: response.stop_reason ?? null,
    usage: {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costMicroUsd: Math.round(
        (input * price.input +
          cacheRead * price.input * CACHE_READ_MULTIPLIER +
          cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
          output * price.output) *
          priceMultiplier,
      ),
      priceKnown: price.known,
    },
  };
}

/**
 * `WriterModel` na Messages API (wywołanie na żywo). Nie importuje niczego
 * z `src/agent` (granica modułu asystenta) — cennik i zdolności modeli są
 * w `src/config`.
 */
export class AnthropicWriterModel implements WriterModel {
  constructor(private readonly client: Anthropic) {}

  async complete(call: WriterModelCall): Promise<WriterModelResult> {
    const response = await this.client.messages.create(messageParams(call));
    return resultFromMessage(call.model, response);
  }
}
