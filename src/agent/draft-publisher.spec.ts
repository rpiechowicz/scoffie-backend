import { Logger } from '@nestjs/common';
import { DraftPublisher } from './agent-turn.runner';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Szkic odpowiedzi w `AgentTurn.draftText` (workstream, Etap 4C): pierwszy
 * fragment od razu, potem najwyżej jeden zapis na sekundę, końcówka zawsze
 * dopisana przez `settle()`.
 */
describe('DraftPublisher', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const make = () => {
    const writes: string[] = [];
    const prisma = {
      agentTurn: {
        updateMany: jest.fn((args: { data: { draftText: string } }) => {
          writes.push(args.data.draftText);
          return Promise.resolve({ count: 1 });
        }),
      },
    };
    const draft = new DraftPublisher(
      prisma as unknown as PrismaService,
      new Logger('test'),
      'turn-1',
    );
    return { draft, writes, prisma };
  };

  /** Strumień: fragment co 50 ms przez `seconds`, tekst rośnie o 4 znaki. */
  const stream = (draft: DraftPublisher, seconds: number) => {
    let text = '';
    for (let t = 0; t < seconds * 1000; t += 50) {
      text += 'abcd';
      draft.push(text);
      jest.advanceTimersByTime(50);
    }
    return text;
  };

  /** Zapisy idą po kolei łańcuchem obietnic — kilka mikrozadań. */
  const tick = async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };

  it('pierwszy fragment idzie od razu (telefon widzi, że odpowiedź powstaje)', async () => {
    const { draft, writes } = make();
    draft.push('Pier');
    await tick();
    expect(writes).toEqual(['Pier']);
  });

  it('8 s strumienia: ~9 zapisów zamiast ~23 (350 ms), końcówka zawsze dojeżdża', async () => {
    const { draft, writes } = make();
    const full = stream(draft, 8);
    await draft.settle();
    await Promise.resolve();
    // 1 natychmiastowy + 1 na każdą pełną sekundę + końcówka z `settle`.
    expect(draft.writes).toBeLessThanOrEqual(10);
    expect(draft.writes).toBeGreaterThanOrEqual(8);
    expect(writes[writes.length - 1]).toBe(full);
    const bytes = writes.reduce((sum, text) => sum + text.length, 0);
    process.stdout.write(
      `[draft] 8 s × fragment 50 ms, ${full.length} znaków: ${draft.writes} zapisów, ${bytes} znaków łącznie\n`,
    );
  });

  it('po settle nic więcej się nie zapisuje (także z zegara w locie)', async () => {
    const { draft, prisma } = make();
    draft.push('a');
    draft.push('ab');
    await draft.settle();
    const calls = prisma.agentTurn.updateMany.mock.calls.length;
    draft.push('abc');
    jest.advanceTimersByTime(5000);
    expect(prisma.agentTurn.updateMany.mock.calls.length).toBe(calls);
  });

  it('zapis jest warunkowy: tylko póki tura jest RUNNING', async () => {
    const { draft, prisma } = make();
    draft.push('x');
    await tick();
    expect(prisma.agentTurn.updateMany).toHaveBeenCalledWith({
      where: { id: 'turn-1', status: 'RUNNING' },
      data: { draftText: 'x' },
    });
  });
});
