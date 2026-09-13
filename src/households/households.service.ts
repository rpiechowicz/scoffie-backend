import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { PrismaService } from '../prisma/prisma.service';
import { MailOutboxService } from '../mail/mail-outbox.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateHouseholdDto } from './dto/create-household.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { UpdateHouseholdDto } from './dto/update-household.dto';
import { UpdateHouseholdMealTypesDto } from './dto/update-meal-types.dto';
import { UpdateHouseholdMealTimesDto } from './dto/update-meal-times.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { normalizeEnabledMealTypes } from '../common/meal-types';
import {
  effectiveAvatarColor,
  pickFreeAvatarColor,
} from '../common/avatar-color.util';
import {
  settleHouseholdAfterMemberLeft,
  revokeCookidooCredentialsOf,
  revokeInvitationsCreatedBy,
} from './household-cleanup.util';
import {
  resolveInvitationStatus,
  shouldAddToInbox,
} from './invitation-status.util';
import {
  onMemberLeft,
  onRosterChanged,
} from '../weekly-plans/utils/plan-roster.util';
import { MemberContext, toMemberContext } from './member-context.util';

/** Najdłuższa ważność linku zaproszenia. */
const INVITATION_MAX_DAYS = 30;

@Injectable()
export class HouseholdsService {
  constructor(
    private readonly prisma: PrismaService,
    // Opcjonalnie — testy jednostkowe budują serwis bez poczty, a brak maila
    // nie ma prawa wywrócić przyjęcia zaproszenia.
    @Optional() private readonly mail?: MailOutboxService,
  ) {}

  /*
   * Walidacja wejścia (Faza 0, krok 2): każda metoda przyjmująca DTO woła
   * `validateDto` i dalej pracuje na ZWALIDOWANEJ instancji (wycięte nieznane
   * pola, zaaplikowane transformacje), a skalarne identyfikatory przechodzą
   * przez `assertUuid` w bramkach niżej. Dekoratory na DTO nie działają na
   * WebSockecie, a te same metody woła in-process asystent — więc to jest
   * jedyna warstwa, która stoi między złym wejściem a Prismą (P2023 albo
   * `PrismaClientValidationError` = 500 bez wskazania pola).
   */

  private async getHouseholdOrThrow(householdId: string) {
    // Nie-UUID w `findUnique` po kolumnie `@db.Uuid` to P2023 → 500; jedna
    // linia tutaj chroni wszystkie ścieżki, które zaczynają od domu.
    assertUuid(householdId, 'householdId');
    const household = await this.prisma.household.findUnique({
      where: { id: householdId },
    });
    if (!household) {
      throw new AppException(
        'HOUSEHOLD_NOT_FOUND',
        'Household not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return household;
  }

  private async ensureMembership(userId: string, householdId: string) {
    // `createInvitation` nie przechodzi przez `getHouseholdOrThrow`, więc
    // bramka jest też tutaj. `userId` nie sprawdzamy — token/`actorId` już to zrobiły.
    assertUuid(householdId, 'householdId');
    const membership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId, householdId } },
    });
    if (!membership) {
      throw new AppException(
        'NOT_HOUSEHOLD_MEMBER',
        'User is not a member of this household',
        HttpStatus.FORBIDDEN,
      );
    }
    return membership;
  }

  private async ensureOwner(userId: string, householdId: string) {
    const membership = await this.ensureMembership(userId, householdId);
    if (membership.role !== 'OWNER') {
      throw new AppException(
        'OWNER_REQUIRED',
        'Only owners can manage household members',
        HttpStatus.FORBIDDEN,
      );
    }
    return membership;
  }

  private async countOwners(householdId: string) {
    return this.prisma.membership.count({
      where: {
        householdId,
        role: 'OWNER',
      },
    });
  }

  async findAll(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    const householdIds = memberships.map((m) => m.householdId);
    return this.prisma.household.findMany({
      where: { id: { in: householdIds } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(userId: string, id: string) {
    const household = await this.getHouseholdOrThrow(id);
    await this.ensureMembership(userId, id);
    return household;
  }

  /**
   * Nowe gospodarstwo z wołającym jako właścicielem.
   *
   * Ta sama reguła co w `acceptInvitation`: konto ma JEDNO gospodarstwo naraz.
   * Bez tej bramki użytkownik z domem A tworzył dom B, dostawał drugie
   * członkostwo — a przy następnym logowaniu i tak lądował w A, bo
   * `buildAuthResult` wybiera najstarsze. Dom B zostawał sierotą, której nikt
   * nie widział. iOS pokazuje kreator tylko bez gospodarstwa, więc 409 to
   * dla niego stan niemożliwy, nie regresja.
   *
   * Jedna transakcja: dom bez właściciela (awaria między dwoma zapisami) był
   * dokładnie tym, co `settleHouseholdAfterMemberLeft` musi potem sprzątać.
   */
  async create(userId: string, dto: CreateHouseholdDto) {
    dto = await validateDto(CreateHouseholdDto, dto);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.membership.findFirst({
        where: { userId },
        select: { householdId: true },
      });
      if (existing) {
        throw new AppException(
          'HOUSEHOLD_ALREADY_MEMBER',
          'User already belongs to a household',
          HttpStatus.CONFLICT,
        );
      }

      const household = await tx.household.create({
        data: {
          name: dto.name,
          createdById: userId,
        },
      });

      await tx.membership.create({
        data: {
          userId,
          householdId: household.id,
          role: 'OWNER',
        },
      });

      return household;
    });
  }

  async createInvitation(
    userId: string,
    householdId: string,
    dto?: CreateInvitationDto,
  ) {
    // iOS wysyła `data: {}`, starsze buildy nie wysyłają `data` wcale — brak
    // to nie błąd, tylko „bez własnego terminu".
    dto = await validateDto(CreateInvitationDto, dto ?? {});
    const membership = await this.ensureMembership(userId, householdId);
    if (membership.role !== 'OWNER') {
      throw new AppException(
        'OWNER_REQUIRED',
        'Only owners can create invitations',
        HttpStatus.FORBIDDEN,
      );
    }

    const token = randomBytes(16).toString('hex');
    let expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : new Date(Date.now() + 7 * 86400000);
    // `@IsDateString` przepuszcza każdą formę ISO 8601 (także tygodniową
    // `2026-W10` i porządkową `2026-060`), a `new Date` części z nich nie
    // parsuje — Invalid Date w Prismie kończyłby się 500.
    // Link „na sto lat" to stały tylny wejściowy do domu — górna granica
    // 30 dni, cicho przycięta (klient i tak pokazuje datę z odpowiedzi).
    const maxExpiresAt = Date.now() + INVITATION_MAX_DAYS * 86400000;
    if (
      !Number.isNaN(expiresAt.getTime()) &&
      expiresAt.getTime() > maxExpiresAt
    ) {
      expiresAt = new Date(maxExpiresAt);
    }
    if (Number.isNaN(expiresAt.getTime())) {
      const detail = 'expiresAt must be a date parsable as ISO 8601 datetime';
      throw new AppException(
        'VALIDATION_ERROR',
        detail,
        HttpStatus.BAD_REQUEST,
        [detail],
      );
    }

    return this.prisma.invitation.create({
      data: {
        token,
        householdId,
        createdById: userId,
        expiresAt,
      },
    });
  }

  async acceptInvitation(userId: string, dto: AcceptInvitationDto) {
    dto = await validateDto(AcceptInvitationDto, dto);
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.token },
    });
    if (!invitation) {
      throw new AppException(
        'INVITATION_NOT_FOUND',
        'Invitation not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (invitation.redeemedAt) {
      throw new AppException(
        'INVITATION_ALREADY_REDEEMED',
        'Invitation already redeemed',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new AppException(
        'INVITATION_EXPIRED',
        'Invitation expired',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (invitation.declinedAt) {
      throw new AppException(
        'INVITATION_DECLINED',
        'Invitation was declined',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Wystawca musi być W TEJ CHWILI właścicielem tego domu.
    //
    // Wygaszanie przy odejściu (`revokeInvitationsCreatedBy`) załatwia to
    // u źródła, ale tylko dla linków wystawionych OD TEJ ZMIANY i tylko dla
    // ścieżek, które pamiętałem. To jest ta sama reguła sprawdzana w chwili
    // użycia — jedyny moment, w którym da się ją sprawdzić na pewno. Łapie
    // też linki wystawione wcześniej, których w bazie nie ruszamy, i wypadek,
    // w którym wystawca skasował konto (`createdById` idzie wtedy na `null`).
    // Fail-closed: brak wystawcy = odmowa, nie domysł.
    const inviterStillOwner = !invitation.createdById
      ? null
      : await this.prisma.membership.findUnique({
          where: {
            userId_householdId: {
              userId: invitation.createdById,
              householdId: invitation.householdId,
            },
          },
          select: { role: true },
        });
    if (!inviterStillOwner || inviterStillOwner.role !== 'OWNER') {
      throw new AppException(
        'INVITATION_EXPIRED',
        'Invitation expired',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Konto obsługuje jedno gospodarstwo naraz. Schemat dopuszcza kilka
    // członkostw, ale reszta aplikacji z tego nie korzysta: `buildAuthResult`
    // wybiera NAJSTARSZE członkostwo, a klient trzyma jedno
    // `currentHouseholdId`. Ciche dopisanie drugiego wyglądało więc tak, że
    // zaproszenie „nie działa": użytkownik po przyjęciu wracał przy następnym
    // logowaniu do starego domu, bo to on był starszy.
    const otherMemberships = await this.prisma.membership.findMany({
      where: {
        userId,
        householdId: { not: invitation.householdId },
      },
      select: { householdId: true },
    });

    // Jawne `=== true`: zgoda na utratę domu ma być booleanem, nie czymś
    // truthy (napis `'false'` liczył się kiedyś jako zgoda).
    if (otherMemberships.length > 0 && dto.leaveOtherHouseholds !== true) {
      throw new AppException(
        'INVITATION_REQUIRES_LEAVE',
        'User already belongs to another household',
        HttpStatus.CONFLICT,
      );
    }

    // Jedna transakcja, bo to są zapisy opisujące JEDNO zdarzenie. Osobno
    // awaria między nimi zostawiała użytkownika bez starego gospodarstwa i bez
    // nowego, albo w gospodarstwie z zaproszeniem wciąż oznaczonym jako
    // niewykorzystane — czyli linkiem, którym mógł dołączyć ktoś kolejny.
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      // Tygodnie, których plan i lista mogły się zmienić — po jednym wpisie na
      // (dom, tydzień), bo przeprowadzka dotyka i domu opuszczanego, i nowego.
      const touchedWeeks: Array<{ householdId: string; weekStart: string }> =
        [];

      for (const previous of otherMemberships) {
        await revokeCookidooCredentialsOf(tx, previous.householdId, userId);
        await revokeInvitationsCreatedBy(tx, previous.householdId, userId, now);
        await tx.membership.delete({
          where: {
            userId_householdId: { userId, householdId: previous.householdId },
          },
        });
        // Dom, z którego właśnie wyszedł ostatni domownik, znika razem
        // z planami i listami — patrz `settleHouseholdAfterMemberLeft`.
        const settlement = await settleHouseholdAfterMemberLeft(
          tx,
          previous.householdId,
        );
        // Dom skasowany = plan poleciał kaskadą, nie ma czego sprzątać.
        // W pozostałych posiłki solo tej osoby znikają, a auto-porcje
        // „Wspólnych" liczą się dla mniejszego składu.
        if (settlement.outcome !== 'DELETED') {
          const roster = await onMemberLeft(
            tx,
            previous.householdId,
            userId,
            now,
          );
          for (const weekStart of roster.touchedWeekStarts) {
            touchedWeeks.push({ householdId: previous.householdId, weekStart });
          }
        }
      }

      // Liczniki dookoła `upsert`, bo `upsert` nie mówi, czy coś stworzył —
      // przy `update: {}` na istniejącym członkostwie skład się NIE zmienia
      // i przeliczanie porcji byłoby błędem.
      const memberCountBefore = await tx.membership.count({
        where: { householdId: invitation.householdId },
      });

      const membership = await tx.membership.upsert({
        where: {
          userId_householdId: {
            userId,
            householdId: invitation.householdId,
          },
        },
        update: {},
        create: {
          userId,
          householdId: invitation.householdId,
          role: 'MEMBER',
        },
      });

      const memberCountAfter = await tx.membership.count({
        where: { householdId: invitation.householdId },
      });
      const joined = await onRosterChanged(
        tx,
        invitation.householdId,
        memberCountBefore,
        memberCountAfter,
        now,
      );
      for (const weekStart of joined.touchedWeekStarts) {
        touchedWeeks.push({ householdId: invitation.householdId, weekStart });
      }

      // Zamek na poziomie bazy: sprawdzenie `redeemedAt` na górze biegło
      // POZA transakcją, więc dwa równoległe kliknięcia w ten sam link
      // wchodziły oba. Zero zmienionych wierszy = ktoś był pierwszy, a cała
      // transakcja (członkostwo, porcje, kolor) się wycofuje.
      const redeemed = await tx.invitation.updateMany({
        where: { id: invitation.id, redeemedAt: null },
        data: {
          redeemedAt: new Date(),
          redeemedById: userId,
          // Adresat jest już znany na pewno — nawet jeśli link podejrzał kto
          // inny, przyjął go ten użytkownik.
          invitedUserId: userId,
        },
      });
      if (redeemed.count === 0) {
        throw new AppException(
          'INVITATION_ALREADY_REDEEMED',
          'Invitation already redeemed',
          HttpStatus.BAD_REQUEST,
        );
      }

      // Kolor awatara był przydzielany w składzie STAREGO domu (albo bez
      // żadnego — onboarding kończy się przed przyjęciem zaproszenia), więc
      // po przeprowadzce potrafił kolidować z kimś na miejscu: każdy
      // „pierwszy" użytkownik dostaje indeks 0 i dwóch takich w jednym domu
      // wyglądało identycznie. Jeśli kolor koliduje albo nigdy nie został
      // przydzielony, bierzemy pierwszy wolny w NOWYM gospodarstwie.
      const [self, housemates] = await Promise.all([
        tx.user.findUniqueOrThrow({
          where: { id: userId },
          // Adres i nazwa do powitania w gospodarstwie — jedno zapytanie
          // zamiast drugiego okrążenia do bazy w tej samej transakcji.
          select: { id: true, avatarColor: true, email: true },
        }),
        tx.user.findMany({
          where: {
            id: { not: userId },
            memberships: { some: { householdId: invitation.householdId } },
          },
          select: { id: true, avatarColor: true },
        }),
      ]);
      const taken = new Set(housemates.map(effectiveAvatarColor));
      if (self.avatarColor === null || taken.has(self.avatarColor)) {
        await tx.user.update({
          where: { id: userId },
          data: { avatarColor: pickFreeAvatarColor(taken, userId) },
        });
      }

      // Powitanie w gospodarstwie. Skład czytamy PO ustaleniu koloru, żeby
      // kółka w mailu miały te same barwy, co chipy w aplikacji.
      if (this.mail) {
        const members = await tx.membership.findMany({
          where: { householdId: invitation.householdId },
          orderBy: { createdAt: 'asc' },
          select: {
            user: { select: { displayName: true, avatarColor: true } },
          },
        });
        const household = await tx.household.findUnique({
          where: { id: invitation.householdId },
          select: { name: true },
        });
        await this.mail.enqueue(tx, {
          template: 'HOUSEHOLD_JOINED',
          // Po ZAPROSZENIU, nie po użytkowniku: ten sam człowiek może dołączyć
          // do kilku domów, a każde dołączenie jest osobnym zdarzeniem.
          dedupeKey: `joined:${invitation.id}`,
          to: self.email,
          userId,
          payload: {
            householdName: household?.name ?? 'Wasze gospodarstwo',
            members: members.map((m) => ({
              name: m.user.displayName,
              avatarColor: m.user.avatarColor,
            })),
          },
        });
      }

      return {
        ...membership,
        leftHouseholdIds: otherMemberships.map((m) => m.householdId),
        touchedWeeks,
      };
    });
  }

  /**
   * Co zaproszenie oznacza dla TEGO użytkownika — i odłożenie go do jego
   * skrzynki.
   *
   * Podgląd nie jest już czystym odczytem: przy okazji przypisuje zaproszenie
   * adresatowi (`invitedUserId`). To jedyny moment, w którym aplikacja poznaje
   * odbiorcę anonimowego linku, a bez tego przypisania zaproszenie otwarte
   * w złym momencie przepadało — nie było ekranu, na którym można by je
   * odnaleźć później.
   */
  async previewInvitation(userId: string, dto: AcceptInvitationDto) {
    dto = await validateDto(AcceptInvitationDto, dto);
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.token },
      include: {
        household: {
          select: {
            id: true,
            name: true,
          },
        },
        createdBy: {
          select: {
            displayName: true,
          },
        },
      },
    });

    if (!invitation) {
      return {
        token: dto.token,
        status: 'NOT_FOUND',
        household: null,
        invitedByDisplayName: null,
        expiresAt: null,
        currentHousehold: null,
        willDeleteCurrentHousehold: false,
      };
    }

    const [existingMembership, otherMemberships] = await Promise.all([
      this.prisma.membership.findUnique({
        where: {
          userId_householdId: {
            userId,
            householdId: invitation.householdId,
          },
        },
      }),
      this.prisma.membership.findMany({
        where: { userId, householdId: { not: invitation.householdId } },
        orderBy: { createdAt: 'asc' },
        include: {
          household: {
            select: {
              id: true,
              name: true,
              _count: { select: { memberships: true } },
            },
          },
        },
      }),
    ]);

    const status = resolveInvitationStatus({
      redeemedAt: invitation.redeemedAt,
      declinedAt: invitation.declinedAt,
      expiresAt: invitation.expiresAt,
      isAlreadyMember: Boolean(existingMembership),
      belongsToAnotherHousehold: otherMemberships.length > 0,
    });

    // Do skrzynki trafia tylko zaproszenie, które adresat MOŻE jeszcze
    // przyjąć, i tylko takie, które nie ma jeszcze adresata — kolejne
    // podejrzenia tego samego linku nie przepisują go z rąk do rąk.
    const addedToInbox = !invitation.invitedUserId && shouldAddToInbox(status);

    if (addedToInbox) {
      await this.prisma.invitation.update({
        where: { id: invitation.id },
        data: { invitedUserId: userId },
      });
    }

    const current = otherMemberships[0]?.household ?? null;

    return {
      token: invitation.token,
      status,
      household: invitation.household,
      invitedByDisplayName: invitation.createdBy?.displayName ?? null,
      expiresAt: invitation.expiresAt,
      /// Dom, który użytkownik straci, przyjmując zaproszenie.
      currentHousehold: current ? { id: current.id, name: current.name } : null,
      /// Czy ten dom zniknie razem z nim, bo nikt w nim nie zostanie. Klient
      /// musi to powiedzieć wprost — usunięcie planów i list zakupów nie może
      /// być niespodzianką po fakcie.
      willDeleteCurrentHousehold: current?._count.memberships === 1,
      /// Czy TO wywołanie odłożyło zaproszenie do skrzynki adresata. Gateway
      /// wysyła na tej podstawie jedno powiadomienie — kolejne podglądy tego
      /// samego linku nie mają już czego zgłaszać.
      addedToInbox,
    };
  }

  /**
   * Zaproszenia czekające na tego użytkownika.
   *
   * To jest ekran „przyszło do mnie zaproszenie", którego wcześniej nie było:
   * zaproszenie żyło wyłącznie jako link w komunikatorze i po zamknięciu
   * alertu nie zostawało po nim w aplikacji nic.
   */
  async listPendingInvitations(userId: string) {
    const invitations = await this.prisma.invitation.findMany({
      where: {
        invitedUserId: userId,
        redeemedAt: null,
        declinedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        household: { select: { id: true, name: true } },
        createdBy: { select: { displayName: true } },
      },
    });

    // Zaproszenie do domu, w którym już się jest, nie jest zaproszeniem —
    // filtrujemy je tutaj, a nie zapytaniem, bo Prisma nie umie w jednym
    // `where` odnieść się do członkostw tego samego użytkownika.
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: { householdId: true },
    });
    const joined = new Set(memberships.map((m) => m.householdId));

    return invitations
      .filter((invitation) => !joined.has(invitation.householdId))
      .map((invitation) => ({
        token: invitation.token,
        household: invitation.household,
        invitedByDisplayName: invitation.createdBy?.displayName ?? null,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      }));
  }

  /**
   * Świadoma odmowa. Zaproszenie znika ze skrzynki, ale zostaje w bazie —
   * bez tego pierwsze ponowne otwarcie linku odłożyłoby je tam z powrotem.
   */
  async declineInvitation(userId: string, dto: AcceptInvitationDto) {
    dto = await validateDto(AcceptInvitationDto, dto);
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.token },
      select: { id: true, redeemedAt: true, invitedUserId: true },
    });
    if (!invitation) {
      throw new AppException(
        'INVITATION_NOT_FOUND',
        'Invitation not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (invitation.redeemedAt) {
      throw new AppException(
        'INVITATION_ALREADY_REDEEMED',
        'Invitation already redeemed',
        HttpStatus.BAD_REQUEST,
      );
    }
    // Zaproszenie z adresatem odrzuca TYLKO adresat. Dla kogoś innego link
    // wygląda jak nieistniejący — nie zdradzamy, że w ogóle jest.
    if (invitation.invitedUserId && invitation.invitedUserId !== userId) {
      throw new AppException(
        'INVITATION_NOT_FOUND',
        'Invitation not found',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        declinedAt: new Date(),
        // Adresata dopisujemy tylko wtedy, gdy jeszcze go nie było. Ten sam
        // link może krążyć między kilkoma osobami i odmowa jednej z nich nie
        // ma prawa przepisać zaproszenia z czyjejś skrzynki na nią.
        ...(invitation.invitedUserId ? {} : { invitedUserId: userId }),
      },
    });

    return { success: true };
  }

  async updateName(
    userId: string,
    householdId: string,
    dto: UpdateHouseholdDto,
  ) {
    dto = await validateDto(UpdateHouseholdDto, dto);
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);
    return this.prisma.household.update({
      where: { id: householdId },
      data: { name: dto.name },
    });
  }

  /**
   * Ustawia sloty posiłków, które gospodarstwo planuje.
   *
   * Świadomie `ensureMembership`, a nie `ensureOwner` jak przy zmianie nazwy:
   * to, czy w domu jada się podwieczorek, nie jest decyzją administracyjną —
   * a wymóg właściciela oznaczałby, że współlokator nie może dołożyć sobie
   * drugiego śniadania.
   *
   * Wyłączenie slotu **nie kasuje** zaplanowanych w nim posiłków. Ukrycie to
   * nie to samo co usunięcie: ktoś może wyłączyć podwieczorek na tydzień
   * urlopu i wrócić do swojego planu. Klient dodatkowo pokazuje wyłączony
   * slot, dopóki coś w nim stoi, więc dane nigdy nie znikają z oczu po cichu.
   */
  async updateMealTypes(
    userId: string,
    householdId: string,
    dto: UpdateHouseholdMealTypesDto,
  ) {
    dto = await validateDto(UpdateHouseholdMealTypesDto, dto);
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);

    // Po walidacji nieznany slot już tu nie dotrze; normalizacja zostaje jako
    // druga linia obrony i jedyne miejsce, które dokłada obowiązkową trójkę.
    const enabledMealTypes = normalizeEnabledMealTypes(dto.mealTypes);

    return this.prisma.household.update({
      where: { id: householdId },
      data: { enabledMealTypes },
    });
  }

  /**
   * Zapisuje pory posiłków gospodarstwa.
   *
   * Mapa idzie do bazy taka, jaka przyszła — klucze i zakres sprawdza
   * `MealSlotTimesConstraint` z DTO, uruchamiany TUTAJ przez `validateDto`
   * (na WebSockecie dekorator sam z siebie nie działa; do kroku 2 Fazy 0
   * dowolny obiekt lądował w kolumnie Json). Świadomie **nie** dokładamy tu
   * domyślnych godzin dla slotów, których klient nie wymienił: brak klucza to
   * informacja („ten posiłek nie ma stałej pory"), a nie luka do wypełnienia.
   */
  async updateMealTimes(
    userId: string,
    householdId: string,
    dto: UpdateHouseholdMealTimesDto,
  ) {
    dto = await validateDto(UpdateHouseholdMealTimesDto, dto);
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);

    return this.prisma.household.update({
      where: { id: householdId },
      data: { mealSlotTimes: dto.mealSlotTimes },
    });
  }

  async listMembers(userId: string, householdId: string) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);
    return this.prisma.membership.findMany({
      where: { householdId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: {
          select: {
            id: true,
            displayName: true,
            // Bez `email`: adres domownika to jego sprawa (przy Sign in with
            // Apple bywa prywatnym relayem, którego celowo nikomu nie pokazał),
            // a klient identyfikuje ludzi po `displayName` i kolorze awatara.
            // Ta lista idzie też broadcastem `households:membersChanged`.
            avatarUrl: true,
            // Kolor awatara jedzie razem z domownikiem, zeby ta sama osoba
            // wygladala tak samo w Ustawieniach i w Planie. Bez tego klient
            // kolorowal awatary domownikow po pozycji na liscie i jeden
            // uzytkownik mial dwa rozne kolory na dwoch ekranach.
            avatarColor: true,
          },
        },
      },
    });
  }

  /**
   * Preferencje, sylwetka i cele WSZYSTKICH domowników — jedno wywołanie.
   *
   * Asystent nie ma jak zebrać tego sam: preferencje siedzą w
   * `UserPreference`, sylwetka w `User`, a `users:preferences:get` czyta
   * tylko własne konto. `listMembers` niesie samą tożsamość, więc „zaplanuj
   * tydzień dla domu" znaczyłoby N wywołań — i tak bez celów makro, bo te
   * do niedawna liczyły się wyłącznie na telefonie
   * (`src/users/body-metrics.util.ts` to port z iOS).
   *
   * Ten sam odczyt zamyka lukę po stronie iOS: po włączeniu auth klient
   * stracił dostęp do cudzych preferencji, więc ekran planu nie wie, kto
   * czego nie je.
   *
   * `ensureMembership`, nie `ensureOwner`: skład domu i tak jest jawny dla
   * domowników, a plan tygodnia jest wspólny. Odczyt jest CZYSTY — nie
   * tworzy brakujących wierszy preferencji (robi to `users:preferences:get`
   * i to jest osobny problem).
   */
  async memberPreferences(
    userId: string,
    householdId: string,
  ): Promise<MemberContext[]> {
    await this.ensureMembership(userId, householdId);
    const rows = await this.prisma.membership.findMany({
      where: { householdId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: {
        role: true,
        user: {
          select: {
            id: true,
            displayName: true,
            sex: true,
            heightCm: true,
            weightKg: true,
            yearOfBirth: true,
            preferences: {
              select: {
                dietPreference: true,
                calorieGoal: true,
                allergens: true,
                goal: true,
                activityLevel: true,
                proteinG: true,
                excludedIngredientIds: true,
                maxPrepTimeMinutes: true,
                fatG: true,
                carbsG: true,
              },
            },
          },
        },
      },
    });
    // Nazwy wykluczonych składników jednym zapytaniem dla całego domu:
    // prompt dostaje „nie je: pieczarka", a nie listę identyfikatorów.
    const excludedIds = Array.from(
      new Set(
        rows.flatMap(
          (row) => row.user.preferences?.excludedIngredientIds ?? [],
        ),
      ),
    );
    const names = new Map<string, string>();
    if (excludedIds.length > 0) {
      const found = await this.prisma.ingredient.findMany({
        where: { id: { in: excludedIds } },
        select: { id: true, name: true },
      });
      for (const ingredient of found) names.set(ingredient.id, ingredient.name);
    }

    return rows.map((row) => toMemberContext(row, new Date(), names));
  }

  async updateMemberRole(
    userId: string,
    householdId: string,
    memberUserId: string,
    dto: UpdateMemberRoleDto,
  ) {
    dto = await validateDto(UpdateMemberRoleDto, dto);
    // `memberUserId` idzie do `findUnique` po kluczu z kolumną `@db.Uuid`.
    assertUuid(memberUserId, 'memberUserId');
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId: memberUserId, householdId } },
    });
    if (!targetMembership) {
      throw new AppException(
        'MEMBER_NOT_FOUND',
        'Member not found in this household',
        HttpStatus.NOT_FOUND,
      );
    }

    if (targetMembership.role === dto.role) {
      return targetMembership;
    }

    if (targetMembership.role === 'OWNER' && dto.role !== 'OWNER') {
      const ownerCount = await this.countOwners(householdId);
      if (ownerCount <= 1) {
        throw new AppException(
          'LAST_OWNER',
          'Household must have at least one owner',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Degradacja OWNER → MEMBER odbiera prawo zapraszania, więc odbiera też
    // moc linkom już wystawionym. Inaczej zdegradowany właściciel mógłby
    // dołączyć kogoś do domu jeszcze przez trzydzieści dni (audyt 12.09.2026).
    if (targetMembership.role === 'OWNER' && dto.role !== 'OWNER') {
      return this.prisma.$transaction(async (tx) => {
        await revokeInvitationsCreatedBy(tx, householdId, memberUserId);
        return tx.membership.update({
          where: { userId_householdId: { userId: memberUserId, householdId } },
          data: { role: dto.role },
        });
      });
    }

    return this.prisma.membership.update({
      where: { userId_householdId: { userId: memberUserId, householdId } },
      data: { role: dto.role },
    });
  }

  async removeMember(
    userId: string,
    householdId: string,
    memberUserId: string,
  ) {
    assertUuid(memberUserId, 'memberUserId');
    await this.getHouseholdOrThrow(householdId);
    await this.ensureOwner(userId, householdId);

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_householdId: { userId: memberUserId, householdId } },
    });
    if (!targetMembership) {
      throw new AppException(
        'MEMBER_NOT_FOUND',
        'Member not found in this household',
        HttpStatus.NOT_FOUND,
      );
    }

    if (targetMembership.role === 'OWNER') {
      const ownerCount = await this.countOwners(householdId);
      if (ownerCount <= 1) {
        throw new AppException(
          'LAST_OWNER',
          'Cannot remove the last owner from household',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      await revokeCookidooCredentialsOf(tx, householdId, memberUserId);
      await revokeInvitationsCreatedBy(tx, householdId, memberUserId, now);
      const removed = await tx.membership.delete({
        where: { userId_householdId: { userId: memberUserId, householdId } },
      });
      // Ta sama reguła co przy wyjściu — kontrola wyżej nie pozwala usunąć
      // ostatniego właściciela, ale porządkowanie ma być jedno dla wszystkich
      // ścieżek, żeby nie zależeć od tego, czy tamta kontrola przetrwa.
      const settlement = await settleHouseholdAfterMemberLeft(tx, householdId);
      // Odchodzi `memberUserId`, nie `userId` — ten drugi to właściciel,
      // który wykonuje usunięcie. Pomyłka tutaj kasowałaby JEGO posiłki.
      const roster =
        settlement.outcome === 'DELETED'
          ? { touchedWeekStarts: [] as string[] }
          : await onMemberLeft(tx, householdId, memberUserId, now);
      return { ...removed, touchedWeekStarts: roster.touchedWeekStarts };
    });
  }

  /**
   * Wyjście z gospodarstwa.
   *
   * Świadomie BEZ blokady dla ostatniego właściciela — inaczej jedyny
   * właściciel byłby uwięziony we własnym domu. Zamiast tego po wyjściu
   * porządkuje dom `settleHouseholdAfterMemberLeft`: pusty znika, a taki, który
   * został bez właściciela, dostaje nowego. Poprzednio nie działo się ani
   * jedno, ani drugie — wyjście zostawiało albo pusty rekord na zawsze, albo
   * dom, którym nikt nie mógł administrować.
   */
  async leave(userId: string, householdId: string) {
    await this.getHouseholdOrThrow(householdId);
    await this.ensureMembership(userId, householdId);

    const now = new Date();
    const { settlement, touchedWeekStarts } = await this.prisma.$transaction(
      async (tx) => {
        await revokeCookidooCredentialsOf(tx, householdId, userId);
        await revokeInvitationsCreatedBy(tx, householdId, userId, now);
        await tx.membership.delete({
          where: { userId_householdId: { userId, householdId } },
        });
        const settled = await settleHouseholdAfterMemberLeft(tx, householdId);
        if (settled.outcome === 'DELETED') {
          return { settlement: settled, touchedWeekStarts: [] as string[] };
        }
        const roster = await onMemberLeft(tx, householdId, userId, now);
        return {
          settlement: settled,
          touchedWeekStarts: roster.touchedWeekStarts,
        };
      },
    );

    return {
      success: true,
      householdDeleted: settlement.outcome === 'DELETED',
      touchedWeekStarts,
    };
  }

  async getUserDisplayName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true },
    });
    return user?.displayName ?? 'Domownik';
  }
}
