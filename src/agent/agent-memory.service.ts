import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { PrismaService } from '../prisma/prisma.service';
import { ensureMembership } from '../weekly-plans/utils/auth-checks.util';

export type MemoryNoteView = {
  id: string;
  text: string;
  createdByUserId: string | null;
  createdAt: string;
};

/**
 * Ile notatek gospodarstwo trzyma naraz.
 *
 * Limit jest twardy z dwóch powodów naraz: notatki idą do promptu w bloku
 * gospodarstwa, który NIE jest cache'owany (patrz `agent-system-prompt.ts`),
 * więc każda kosztuje przy każdej turze; a pamięć, do której wszystko wpada
 * i nic nie wypada, po miesiącu przestaje być pamięcią i staje się śmietnikiem.
 */
export const MEMORY_LIMIT = 30;
/** Jedno zdanie, nie akapit — długie „wspomnienia" to zwykle streszczenie rozmowy. */
export const MEMORY_TEXT_MAX = 200;

/**
 * Pamięć asystenta między rozmowami.
 *
 * Model widzi historię TYLKO w obrębie jednej rozmowy (`HISTORY_WINDOW`), więc
 * bez tego każda nowa rozmowa zaczynała od zera: „w środy jemy u teściów"
 * trzeba było powtarzać co tydzień.
 *
 * Zakres to gospodarstwo, nie użytkownik — plan tygodnia, lista zakupów
 * i kwota też są wspólne, a notatka „Kuba nie je ryb" przydaje się każdemu,
 * kto układa plan.
 */
@Injectable()
export class AgentMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(householdId: string): Promise<MemoryNoteView[]> {
    assertUuid(householdId, 'householdId');
    const notes = await this.prisma.agentMemory.findMany({
      where: { householdId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MEMORY_LIMIT,
    });
    return notes.map((note) => ({
      id: note.id,
      text: note.text,
      createdByUserId: note.createdByUserId,
      createdAt: note.createdAt.toISOString(),
    }));
  }

  /**
   * Zapisuje notatkę i pilnuje limitu.
   *
   * Po przekroczeniu limitu wypada NAJSTARSZA notatka, a nie nowa: to, co
   * użytkownik powiedział przed chwilą, jest prawdziwsze niż to, co powiedział
   * pół roku temu (przeprowadzka, zmiana diety, dziecko w domu).
   *
   * Duplikaty odbijamy po znormalizowanej treści — model, który usłyszy to samo
   * w trzech rozmowach, zapisałby to trzy razy i trzy razy za to zapłacił.
   */
  async remember(
    householdId: string,
    userId: string,
    rawText: string,
  ): Promise<MemoryNoteView> {
    assertUuid(householdId, 'householdId');
    const text = rawText.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX);
    if (!text) {
      throw new AppException(
        'VALIDATION_ERROR',
        'Notatka nie może być pusta.',
        HttpStatus.BAD_REQUEST,
        ['text'],
      );
    }

    // Porównanie bez rozróżniania wielkości liter: „Kuba nie je ryb"
    // i „kuba nie je ryb" to jedna notatka.
    const duplicate = await this.prisma.agentMemory.findFirst({
      where: { householdId, text: { equals: text, mode: 'insensitive' } },
      select: {
        id: true,
        text: true,
        createdByUserId: true,
        createdAt: true,
      },
    });
    if (duplicate) {
      return {
        id: duplicate.id,
        text: duplicate.text,
        createdByUserId: duplicate.createdByUserId,
        createdAt: duplicate.createdAt.toISOString(),
      };
    }

    const note = await this.prisma.agentMemory.create({
      data: { householdId, text, createdByUserId: userId },
    });

    await this.trim(householdId);

    return {
      id: note.id,
      text: note.text,
      createdByUserId: note.createdByUserId,
      createdAt: note.createdAt.toISOString(),
    };
  }

  /**
   * Lista dla klienta — z bramką członkostwa.
   *
   * Osobno od `list`, bo tamtą woła prompt tury, który tożsamość ma już
   * sprawdzoną i nie może płacić za drugie zapytanie o członkostwo.
   */
  async listForUser(
    userId: string,
    householdId: string,
  ): Promise<MemoryNoteView[]> {
    await ensureMembership(this.prisma, userId, householdId);
    return this.list(householdId);
  }

  /**
   * Kasowanie notatki. Gospodarstwo bierzemy Z NOTATKI, a członkostwo
   * sprawdzamy dopiero po nim — inaczej klient musiałby podawać `householdId`
   * w adresie i mógłby podać cudzy.
   */
  async forget(userId: string, noteId: string): Promise<{ deleted: number }> {
    assertUuid(noteId, 'noteId');
    const note = await this.prisma.agentMemory.findUnique({
      where: { id: noteId },
      select: { householdId: true },
    });
    if (!note) {
      throw new AppException(
        'NOT_FOUND',
        'Tej notatki już nie ma.',
        HttpStatus.NOT_FOUND,
      );
    }
    await ensureMembership(this.prisma, userId, note.householdId);
    await this.prisma.agentMemory.delete({ where: { id: noteId } });
    // Kształt jak przy kasowaniu rozmów: klient dostaje ciało, a nie pustkę,
    // której nie da się zdekodować.
    return { deleted: 1 };
  }

  /**
   * Notatki jako blok do promptu. Pusto = pusty string, żeby prompt nie miał
   * nagłówka nad niczym.
   */
  async promptBlock(householdId: string): Promise<string> {
    const notes = await this.list(householdId);
    if (notes.length === 0) return '';
    return [
      'CO ASYSTENT PAMIĘTA O TYM DOMU (notatki z poprzednich rozmów):',
      ...notes.map((note) => `- ${note.text}`),
    ].join('\n');
  }

  private async trim(householdId: string): Promise<void> {
    const surplus = await this.prisma.agentMemory.findMany({
      where: { householdId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: MEMORY_LIMIT,
      select: { id: true },
    });
    if (surplus.length === 0) return;
    await this.prisma.agentMemory.deleteMany({
      where: { id: { in: surplus.map((note) => note.id) } },
    });
  }
}
