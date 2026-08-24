/**
 * Zbieracz zdarzeń, który zamienia serię drobnych zmian w jedno powiadomienie.
 *
 * Powód istnienia: jedna sesja układania planu to kilkanaście osobnych wywołań
 * `weeklyPlans:upsertWeekSlot` — po jednym na kratkę — a każde z nich wysyłało
 * do drugiego domownika osobny push. Poprzednia obrona (`dedupeCache` z oknem
 * 1,5 s) kasowała wyłącznie dwuklik w TEN SAM slot, bo klucz zawierał dzień i
 * posiłek; dwie różne kratki nigdy się nie zlewały. Tutaj klucz jest celowo
 * grubszy — gospodarstwo, autor, kategoria — więc cała sesja składa się w jedną
 * wiadomość.
 *
 * Okno jest przesuwne: każde kolejne zdarzenie odsuwa wysyłkę o `windowMs`, bo
 * „skończył edytować" nie ma innego sygnału niż cisza. `maxWaitMs` jest po to,
 * żeby ktoś, kto klika bez przerwy przez pół godziny, nie zablokował wysyłki na
 * zawsze — po tym czasie paczka wychodzi mimo trwającej aktywności.
 *
 * Stan jest w pamięci procesu i ginie przy restarcie kontenera. To jest
 * świadomy wybór, nie przeoczenie: zgubione podsumowanie zmian w planie kosztuje
 * jedno niewysłane powiadomienie, a kolejka w bazie albo Redisie kosztowałaby
 * osobną infrastrukturę w projekcie, który chodzi na jednym kontenerze API
 * (`docker-compose.yml`, jedna usługa `api`). Gdyby API kiedyś ruszyło w kilku
 * replikach, każda z nich zbierałaby własną paczkę i użytkownik dostałby tyle
 * powiadomień, ile replik — wtedy to miejsce trzeba wymienić na wspólny bufor.
 */
export interface NotificationBatcherOptions {
  /** Cisza po ostatnim zdarzeniu, po której paczka wychodzi. */
  windowMs: number;
  /** Twardy sufit od PIERWSZEGO zdarzenia w paczce. */
  maxWaitMs: number;
}

interface Batch<TEvent> {
  events: TEvent[];
  firstEventAtMs: number;
  timer: NodeJS.Timeout;
}

export class NotificationBatcher<TEvent> {
  private readonly batches = new Map<string, Batch<TEvent>>();

  constructor(
    private readonly options: NotificationBatcherOptions,
    private readonly onFlush: (key: string, events: TEvent[]) => Promise<void>,
    /**
     * Zwraca liczbę milisekund, o które trzeba odroczyć wysyłkę (0 = wysyłaj
     * teraz). Tędy wchodzi cisza nocna: paczka nie ginie, tylko czeka do rana.
     * Wstrzykiwane, a nie liczone tutaj, bo odroczenie zależy od preferencji
     * odbiorców, o których ten moduł nic nie wie.
     */
    private readonly resolveDeferralMs: (
      key: string,
      events: TEvent[],
    ) => Promise<number> = () => Promise.resolve(0),
  ) {}

  enqueue(key: string, event: TEvent): void {
    const now = Date.now();
    const existing = this.batches.get(key);

    if (!existing) {
      const batch: Batch<TEvent> = {
        events: [event],
        firstEventAtMs: now,
        timer: this.scheduleFlush(key, this.options.windowMs),
      };
      this.batches.set(key, batch);
      return;
    }

    existing.events.push(event);
    clearTimeout(existing.timer);

    // Sufit liczony od pierwszego zdarzenia. `Math.max(0, …)` bo przy bardzo
    // długiej sesji reszta budżetu bywa ujemna — wtedy wysyłamy natychmiast.
    const remainingBudgetMs = Math.max(
      0,
      existing.firstEventAtMs + this.options.maxWaitMs - now,
    );
    existing.timer = this.scheduleFlush(
      key,
      Math.min(this.options.windowMs, remainingBudgetMs),
    );
  }

  /** Ile paczek czeka w tej chwili — do testów i diagnostyki. */
  get pendingCount(): number {
    return this.batches.size;
  }

  /** Porzuca wszystko bez wysyłki. Woła się przy zamykaniu aplikacji. */
  dispose(): void {
    for (const batch of this.batches.values()) {
      clearTimeout(batch.timer);
    }
    this.batches.clear();
  }

  private scheduleFlush(key: string, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      // `catch` jest obowiązkowy, nie ozdobny: `flush` startuje z timera, więc
      // nie ma nikogo, kto by na niego czekał. Odrzucona obietnica bez
      // odbiorcy to w Node 20 `unhandledRejection`, czyli ubity proces API —
      // przez nieudaną wysyłkę powiadomienia.
      void this.flush(key).catch(() => undefined);
    }, delayMs);
    // Czekająca paczka nie może trzymać procesu przy życiu — inaczej
    // `SIGTERM` przy deployu wisiałby do końca okna.
    timer.unref?.();
    return timer;
  }

  private async flush(key: string): Promise<void> {
    const batch = this.batches.get(key);
    if (!batch) {
      return;
    }

    // Nieudane ustalenie odroczenia (np. baza chwilowo nieosiągalna) nie może
    // zatrzymać paczki na zawsze — wtedy po prostu wysyłamy.
    let deferralMs = 0;
    try {
      deferralMs = await this.resolveDeferralMs(key, batch.events);
    } catch {
      deferralMs = 0;
    }
    if (deferralMs > 0) {
      // Paczka zostaje w mapie i czeka dalej. Kolejne zdarzenia dosypią się do
      // niej normalnie, więc po ciszy nocnej wychodzi jedno podsumowanie
      // obejmujące także to, co działo się w nocy.
      const stillPending = this.batches.get(key);
      if (stillPending === batch) {
        batch.timer = this.scheduleFlush(key, deferralMs);
      }
      return;
    }

    this.batches.delete(key);
    clearTimeout(batch.timer);
    await this.onFlush(key, batch.events);
  }
}
