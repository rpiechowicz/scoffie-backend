import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { readMailEnv } from './mail-env';
import {
  MailRefusal,
  checkEligibility,
  normalizeEmail,
} from './mail-eligibility';
import { MailPayloads, MailTemplateId } from './mail-template';

/** Ten sam wzorzec co `UsageCounterClient`: serwis albo klient transakcji. */
export type MailOutboxClient = Prisma.TransactionClient | PrismaService;

export type EnqueueOutcome = 'QUEUED' | 'DUPLICATE' | MailRefusal;

export type EnqueueInput<T extends MailTemplateId> = {
  template: T;
  /** Klucz zdarzenia, nie wiadomości — patrz `MailMessage.dedupeKey`. */
  dedupeKey: string;
  to: string | null | undefined;
  userId?: string | null;
  payload: MailPayloads[T];
};

/**
 * Wstawianie do skrzynki nadawczej. Jedyne wejście dla kodu domeny.
 *
 * DWIE ZASADY, KTÓRE TRZYMAJĄ CAŁOŚĆ:
 *
 * 1. **Nigdy nie rzuca.** Mail jest dodatkiem do zdarzenia, nie jego częścią.
 *    Wyjątek z kolejkowania, który wywraca przyjęcie zaproszenia albo kasowanie
 *    konta, byłby gorszy niż brak maila — a przy wołaniu wewnątrz transakcji
 *    wywróciłby również ją.
 *
 * 2. **Wstawia przez `createMany({ skipDuplicates: true })`, nie `create`.**
 *    To nie jest kosmetyka. W Postgresie naruszenie klucza unikalnego
 *    UNIEWAŻNIA CAŁĄ TRANSAKCJĘ — złapany `P2002` nie pomaga, bo dalsze
 *    zapytania w tej samej transakcji i tak dostaną „current transaction is
 *    aborted". Kasowanie konta kolejkuje pożegnanie w środku swojej transakcji,
 *    więc druga próba usunięcia tego samego konta wywróciłaby operację, którą
 *    mail miał tylko opisać. `skipDuplicates` to `ON CONFLICT DO NOTHING` —
 *    bez błędu i bez zatrutej transakcji.
 */
@Injectable()
export class MailOutboxService {
  private readonly logger = new Logger(MailOutboxService.name);

  constructor(private readonly prisma: PrismaService) {}

  async enqueue<T extends MailTemplateId>(
    client: MailOutboxClient,
    input: EnqueueInput<T>,
  ): Promise<EnqueueOutcome> {
    try {
      return await this.tryEnqueue(client, input);
    } catch (error) {
      this.logger.warn(
        `nie udało się zakolejkować ${input.template}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 'MAIL_DISABLED';
    }
  }

  /** Wygodne wejście dla miejsc bez własnej transakcji. */
  async enqueueStandalone<T extends MailTemplateId>(
    input: EnqueueInput<T>,
  ): Promise<EnqueueOutcome> {
    return this.enqueue(this.prisma, input);
  }

  private async tryEnqueue<T extends MailTemplateId>(
    client: MailOutboxClient,
    input: EnqueueInput<T>,
  ): Promise<EnqueueOutcome> {
    const env = readMailEnv();
    if (!env.enabled) return 'MAIL_DISABLED';

    const address = (input.to ?? '').trim();
    // Listę wykluczeń czytamy TYM SAMYM klientem, żeby wołanie wewnątrz
    // transakcji nie sięgało poza nią i nie zawisło na własnej blokadzie.
    const suppressed =
      address === ''
        ? false
        : (await client.mailSuppression.findUnique({
            where: { email: normalizeEmail(address) },
            select: { email: true },
          })) !== null;

    const eligibility = checkEligibility({
      email: address,
      mailEnabled: true,
      suppressed,
    });
    if (!eligibility.ok) return eligibility.reason;

    const created = await client.mailMessage.createMany({
      data: [
        {
          dedupeKey: input.dedupeKey,
          template: input.template,
          to: eligibility.to,
          userId: input.userId ?? null,
          payload: input.payload as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });

    return created.count === 1 ? 'QUEUED' : 'DUPLICATE';
  }
}
