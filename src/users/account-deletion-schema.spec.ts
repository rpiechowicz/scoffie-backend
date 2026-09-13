import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bramka na pytanie „co zostaje w systemie po usunięciu konta?".
 *
 * `UsersService.deleteAccount` kończy się `tx.user.delete()`, więc o losie
 * każdego wiersza wiszącego na `User` decyduje `onDelete` w schemacie — a nie
 * kod, który ktoś pamiętał napisać. Dlatego to jest test SCHEMATU, nie serwisu:
 * nowa relacja do `User` dopisana za pół roku nie ma jak przejść niezauważona.
 *
 * Trzy reguły:
 *
 *  1. `Cascade` — wiersz ginie razem z kontem. Domyślna, bezpieczna odpowiedź;
 *     nie wymaga wpisu nigdzie.
 *  2. `SetNull` — wiersz ZOSTAJE, bez identyfikatora osoby. To jest zawsze
 *     decyzja (rozliczenia, wspólne dane domu, ślad operacyjny), więc musi być
 *     na liście niżej razem z powodem. Brak na liście = ktoś zostawił dane
 *     osobowe w systemie bez decyzji.
 *  3. `Restrict`/`NoAction` (także BRAK `onDelete` — dla relacji wymaganej
 *     Prisma przyjmuje wtedy `Restrict`) — `user.delete()` PADA na P2003
 *     i człowiek nie może skasować konta. Nigdy dozwolone; to nie jest
 *     ostrożność, to awaria art. 17 RODO i App Store 5.1.1(v).
 */

const SCHEMA = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
  'utf8',
);

/**
 * Relacje do `User`, które ZOSTAWIAJĄ wiersz po skasowaniu konta — każda
 * z powodem. Klucz to `<pole>` tak, jak stoi w schemacie.
 *
 * Zgodność z `deleteAccount` (kolejność jak w serwisie):
 *  • `connectedById` — wiersz jest wcześniej KASOWANY jawnie (polityka §12),
 *    `SetNull` jest tu tylko siatką.
 *  • `createdById` (Invitation) — zaproszenia tej osoby są wcześniej
 *    wygaszane (`revokeInvitationsCreatedBy`), więc martwy link nie wraca.
 *  • `userId` (MailMessage) — `QUEUED` schodzi wcześniej na `SKIPPED`, żeby
 *    poczta nie poszła po skasowaniu konta; historia wysyłek zostaje.
 */
const KEEPS_ROW_ON_PURPOSE: Record<string, string> = {
  // Household.createdBy
  createdById:
    'dom żyje dalej dla pozostałych domowników; „założony przez" traci osobę',
  // Subscription.purchaser
  purchaserUserId:
    'Apple pobiera pieniądze od tożsamości zakupowej, nie od konta u nas — ' +
    'ponowne logowanie tym samym Apple ID odzyskuje opłacone PRO',
  // CookidooIntegration.connectedBy
  connectedById: 'kasowane jawnie w deleteAccount; SetNull to tylko siatka',
  // Invitation.invitedUser / .redeemedBy
  invitedUserId: 'ślad, do kogo szło zaproszenie — bez osoby',
  redeemedById: 'ślad, kto przyjął zaproszenie — bez osoby',
  // MailMessage.user
  userId:
    'historia wysyłek jest dowodem operacyjnym; QUEUED schodzi wcześniej na SKIPPED',
};

type UserRelation = {
  model: string;
  field: string;
  onDelete: string | null;
  line: number;
};

/** Wszystkie relacje do `User` w schemacie, z modelem, w którym stoją. */
function userRelations(): UserRelation[] {
  const found: UserRelation[] = [];
  let model = '?';
  const lines = SCHEMA.split(/\r?\n/);

  lines.forEach((line, index) => {
    const modelStart = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelStart) {
      model = modelStart[1];
      return;
    }
    // `author      User      @relation(...)` — typ `User` albo `User?`,
    // zawsze z `@relation`, bo bez niego nie ma klucza obcego.
    if (!/^\s*\w+\s+User\??\s+@relation\(/.test(line)) return;

    const field = /fields:\s*\[(\w+)\]/.exec(line);
    const onDelete = /onDelete:\s*(\w+)/.exec(line);
    found.push({
      model,
      field: field ? field[1] : '?',
      onDelete: onDelete ? onDelete[1] : null,
      line: index + 1,
    });
  });

  return found;
}

describe('schemat a kasowanie konta', () => {
  const relations = userRelations();

  it('parser widzi relacje do User (inaczej cały plik jest zielony na darmo)', () => {
    // Bez tej asercji literówka w regeksie zamieniłaby wszystkie testy niżej
    // w pustą pętlę — czyli w test, który przechodzi mimo błędnej implementacji.
    expect(relations.length).toBeGreaterThanOrEqual(18);
    expect(relations.map((r) => r.model)).toContain('Membership');
    expect(relations.map((r) => r.model)).toContain('RefreshToken');
  });

  it.each(relations.map((r) => [`${r.model}.${r.field}`, r] as const))(
    '%s ma jawne onDelete — brak = Restrict = konta nie da się skasować',
    (_label, relation) => {
      expect(relation.onDelete).not.toBeNull();
    },
  );

  it.each(relations.map((r) => [`${r.model}.${r.field}`, r] as const))(
    '%s nie blokuje kasowania konta',
    (_label, relation) => {
      // `Restrict`/`NoAction` na relacji do `User` to P2003 przy
      // `tx.user.delete()` — wniosek RODO kończy się wtedy błędem 500.
      expect(['Restrict', 'NoAction']).not.toContain(relation.onDelete);
    },
  );

  it.each(
    relations
      .filter((r) => r.onDelete === 'SetNull')
      .map((r) => [`${r.model}.${r.field}`, r] as const),
  )(
    '%s zostawia wiersz ŚWIADOMIE — jest na liście z powodem',
    (_label, relation) => {
      // Nowa relacja `SetNull` bez wpisu = dane osobowe zostają w systemie,
      // bo nikt nie zdecydował, że mają zostać. Dopisanie powodu jest tanie;
      // milczące zostawienie danych nie.
      expect(Object.keys(KEEPS_ROW_ON_PURPOSE)).toContain(relation.field);
      expect(KEEPS_ROW_ON_PURPOSE[relation.field].length).toBeGreaterThan(20);
    },
  );

  it('lista powodów nie zawiera martwych wpisów', () => {
    // Relacja przestawiona na `Cascade` albo usunięta ze schematu zostawia
    // w liście wpis, który już niczego nie opisuje — a przy następnym audycie
    // wygląda jak decyzja, której nikt nie podjął.
    const setNullFields = new Set(
      relations.filter((r) => r.onDelete === 'SetNull').map((r) => r.field),
    );
    for (const field of Object.keys(KEEPS_ROW_ON_PURPOSE)) {
      expect(setNullFields).toContain(field);
    }
  });
});
