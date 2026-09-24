import { formatTurnTiming } from './agent-timing';

describe('formatTurnTiming', () => {
  it('rozbija turę na wywołania, bez treści rozmowy', () => {
    const line = formatTurnTiming('t-1', 23_400, 1_800, [
      {
        model: 'claude-sonnet-5',
        totalMs: 8_200,
        firstBlockMs: 1_200,
        thinkingMs: 4_100,
        toolInputMs: 900,
        textMs: 0,
        outputTokens: 410,
        tools: ['get_week_plan', 'get_week_balance'],
        toolsRunMs: 300,
      },
      {
        model: 'claude-sonnet-5',
        totalMs: 13_000,
        firstBlockMs: null,
        thinkingMs: 0,
        toolInputMs: 0,
        textMs: 2_000,
        outputTokens: 120,
        tools: [],
        toolsRunMs: null,
      },
    ]);

    expect(line).toBe(
      'agent-timing turn=t-1 total=23400 prep=1800 calls=2 ' +
        'c1=claude-sonnet-5,total=8200,first=1200,think=4100,tool_in=900,text=0,out=410,run=300,tools=get_week_plan+get_week_balance ' +
        'c2=claude-sonnet-5,total=13000,first=-,think=0,tool_in=0,text=2000,out=120,run=-,tools=-',
    );
  });
});
