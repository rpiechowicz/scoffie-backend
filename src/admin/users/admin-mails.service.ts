import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/app-exception';
import { checkEligibility, normalizeEmail } from '../../mail/mail-eligibility';
import { readMailEnv } from '../../mail/mail-env';
import { isOperatorMailTemplate } from '../../mail/mail-template';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';

/** Jedyny szablon, który wolno wysłać osobie, której konto już nie istnieje. */
const FAREWELL_TEMPLATE = 'ACCOUNT_DELETED';

const conflict = (message: string) =>
  new AppException('CONFLICT', message, HttpStatus.CONFLICT);

/**
 * „Ponów" przy mailu FAILED (ROADMAPA §5.10).
 *
 * Moduł poczty nie ma drogi ponowienia, a robotnik (`MailWorkerService`)
 * czyta WYŁĄCZNIE `status` i `nextAttemptAt`. Ponowienie to więc powrót
 * wiersza do kolejki: `QUEUED` z `nextAttemptAt = teraz` — robotnik weźmie go
 * przy najbliższym przebiegu swoim zwykłym, warunkowym zajęciem.
 *
 * `attempts` ZOSTAJE: to historia prawdziwych prób (panel pokazuje „prób 5"),
 * a ręczne „Ponów" to jedna próba ponad wyczerpany budżet — kolejna porażka
 * wraca od razu do FAILED z nowym `lastError`, zamiast rozpędzać od zera
 * pięciostopniowy cykl ponowień, o który nikt nie prosił.
 *
 * Przed zwrotem do kolejki te same bramki, co przy kolejkowaniu
 * (`checkEligibility`): poczta włączona, adres wygląda na adres i nie leży na
 * liście wykluczeń — ponowny strzał w twardo odbity adres psuje reputację
 * domeny wszystkim pozostałym mailom. Do tego dwie, których kolejka nie ma:
 * wiersz po retencji (bez adresu i treści) i konto, którego już nie ma —
 * po usunięciu konta wychodzi tylko pożegnanie (`deleteAccount` gasi resztę).
 */
@Injectable()
export class AdminMailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  retry(actor: AdminActor, id: string): Promise<void> {
    return this.audit
      .run(
        actor,
        { action: 'mail.retry', targetType: 'MailMessage', targetId: id },
        async () => {
          const mail = await this.prisma.mailMessage.findUnique({
            where: { id },
            select: {
              status: true,
              template: true,
              to: true,
              userId: true,
              scrubbedAt: true,
              attempts: true,
            },
          });
          if (!mail) {
            throw new AppException(
              'NOT_FOUND',
              'Nie ma takiego maila.',
              HttpStatus.NOT_FOUND,
            );
          }
          if (mail.status !== 'FAILED') {
            throw conflict(
              `Ponowić można tylko mail, który nie wyszedł (FAILED) — ten ma status ${mail.status}.`,
            );
          }
          if (mail.scrubbedAt || mail.to.trim() === '') {
            throw conflict(
              'Retencja wyczyściła już adres i treść tego maila — nie ma czego wysłać.',
            );
          }
          // Bez konta wolno wysłać tylko dwa rodzaje maili: pożegnanie (konto
          // skasowano, a mail o tym ma dojść) i mail DO OPERATORA (alert,
          // raport dzienny) — ten nie miał konta nigdy, adresat pochodzi
          // z `ADMIN_ALERT_EMAILS`. Każdy inny szablon bez `userId` znaczy
          // „osoba usunęła konto” i jej maili już nie ponawiamy.
          if (
            !mail.userId &&
            mail.template !== FAREWELL_TEMPLATE &&
            !isOperatorMailTemplate(mail.template)
          ) {
            throw conflict(
              'Konto adresata już nie istnieje — po usunięciu konta wychodzi tylko pożegnanie.',
            );
          }

          const env = readMailEnv();
          if (!env.enabled) {
            throw new AppException(
              'SERVICE_UNAVAILABLE',
              'Poczta jest wyłączona (MAIL_ENABLED) — ponowienie niczego by nie wysłało.',
              HttpStatus.SERVICE_UNAVAILABLE,
            );
          }
          const suppressed =
            (await this.prisma.mailSuppression.findUnique({
              where: { email: normalizeEmail(mail.to) },
              select: { email: true },
            })) !== null;
          const eligibility = checkEligibility({
            email: mail.to,
            mailEnabled: env.enabled,
            suppressed,
          });
          if (!eligibility.ok) {
            throw conflict(
              eligibility.reason === 'SUPPRESSED'
                ? 'Adres jest na liście wykluczeń (twardy odrzut albo skarga) — ponowienie zaszkodziłoby reputacji domeny.'
                : `Tego maila nie da się wysłać (${eligibility.reason}).`,
            );
          }

          // Warunkowo: tylko z FAILED i tylko nieszorowany. Drugi klik albo
          // retencja w tej samej chwili nie cofną wiersza, który zmienił stan.
          const { count } = await this.prisma.mailMessage.updateMany({
            where: { id, status: 'FAILED', scrubbedAt: null },
            data: { status: 'QUEUED', nextAttemptAt: new Date() },
          });
          if (count === 0) {
            throw conflict('Mail zmienił stan w międzyczasie — odśwież kartę.');
          }
          return { template: mail.template, attempts: mail.attempts };
        },
        (result) => result,
      )
      .then(() => undefined);
  }
}
