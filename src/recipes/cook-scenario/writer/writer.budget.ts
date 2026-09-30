import { priceFor } from '../../../config/model-prices';
import type {
  WriterModel,
  WriterModelCall,
  WriterModelResult,
} from './writer.types';

/** Zapis do cache liczony drożej od zwykłego wejścia (5 min = 1,25×). */
const WORST_INPUT_MULTIPLIER = 1.25;

export class BudgetExceededError extends Error {
  constructor(
    readonly limitMicroUsd: number,
    readonly committedMicroUsd: number,
    readonly neededMicroUsd: number,
  ) {
    super(
      `budżet ${(limitMicroUsd / 1e6).toFixed(2)} $: wydane i zarezerwowane ${(committedMicroUsd / 1e6).toFixed(3)} $, kolejne wywołanie może kosztować do ${(neededMicroUsd / 1e6).toFixed(3)} $`,
    );
    this.name = 'BudgetExceededError';
  }
}

/** Narzut na ramę wiadomości, instrukcje formatu i narzędzia API. */
const REQUEST_OVERHEAD_TOKENS = 2_000;

/**
 * Najdroższy możliwy koszt wywołania: każdy BAJT UTF-8 promptu i schematu
 * jako osobny token (tokenizer bajtowy nie da ich więcej — a znaków już
 * tak, „ą” to dwa bajty), plus narzut, całe wejście po stawce zapisu do
 * cache i pełne `max_tokens` wyjścia (myślenie się w nim mieści). Z górą —
 * dzięki temu limit jest twardy.
 */
export function worstCaseMicroUsd(
  call: WriterModelCall,
  priceMultiplier = 1,
): number {
  const price = priceFor(call.model);
  const inputTokens =
    Buffer.byteLength(call.system, 'utf8') +
    Buffer.byteLength(call.user, 'utf8') +
    Buffer.byteLength(JSON.stringify(call.schema), 'utf8') +
    REQUEST_OVERHEAD_TOKENS;
  return Math.ceil(
    (inputTokens * price.input * WORST_INPUT_MULTIPLIER +
      call.maxTokens * price.output) *
      priceMultiplier,
  );
}

/**
 * Twardy limit wydatków na serię (review Codexa, E3a runda 1): rezerwacja
 * PRZED każdym wywołaniem modelu, rozliczenie po nim. Sprawdzenie
 * i rezerwacja są synchroniczne, więc równoległe przepisy (jeden wątek JS)
 * nie prześcigną się — suma wydanego nigdy nie przekroczy limitu.
 */
export class BudgetGuard {
  private spent: number;
  private reserved = 0;

  /**
   * `spentMicroUsd` — wydane wcześniej (wznowienie przebiegu z dziennika):
   * limit dotyczy CAŁEJ serii, nie jednego uruchomienia.
   */
  constructor(
    readonly limitMicroUsd: number,
    spentMicroUsd = 0,
  ) {
    this.spent = spentMicroUsd;
  }

  /** Rozliczone — BEZ rezerwacji w locie (te dziennik trzyma osobno). */
  get spentMicroUsd(): number {
    return this.spent;
  }

  get reservedMicroUsd(): number {
    return this.reserved;
  }

  reserve(amount: number): void {
    if (this.spent + this.reserved + amount > this.limitMicroUsd) {
      throw new BudgetExceededError(
        this.limitMicroUsd,
        this.spent + this.reserved,
        amount,
      );
    }
    this.reserved += amount;
  }

  /**
   * Rezerwacja bez sprawdzania limitu — dla paczki wysłanej w poprzednim
   * uruchomieniu: pieniądze już poszły, odbieramy tylko wynik.
   */
  forceReserve(amount: number): void {
    this.reserved += amount;
  }

  settle(reservedAmount: number, actual: number): void {
    this.reserved -= reservedAmount;
    this.spent += actual;
  }
}

/** `WriterModel`, który nie wykona wywołania, na które nie ma budżetu. */
export class BudgetedWriterModel implements WriterModel {
  constructor(
    private readonly inner: WriterModel,
    private readonly guard: BudgetGuard,
  ) {}

  async complete(call: WriterModelCall): Promise<WriterModelResult> {
    const reservation = worstCaseMicroUsd(call);
    this.guard.reserve(reservation);
    let actual = reservation;
    try {
      const result = await this.inner.complete(call);
      actual = result.usage.costMicroUsd;
      return result;
    } finally {
      // Błąd API po wysłaniu żądania mógł kosztować — liczymy rezerwację
      // w całości; lepiej zatrzymać serię za wcześnie niż za późno.
      this.guard.settle(reservation, actual);
    }
  }
}
