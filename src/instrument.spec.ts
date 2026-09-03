process.env.SENTRY_DSN = '';
import { scrubEvent } from './instrument';

describe('scrubEvent', () => {
  it('zdejmuje nagłówki, cookies, ciało i dane osobowe użytkownika', () => {
    const event = scrubEvent({
      request: {
        url: 'https://api/x',
        headers: { authorization: 'Bearer tajne' },
        cookies: { a: 'b' },
        data: { text: 'treść wiadomości' },
        query_string: 'q=1',
      },
      user: { id: 'u1', email: 'a@b.pl', ip_address: '1.2.3.4' },
    } as never) as {
      request?: Record<string, unknown>;
      user?: Record<string, unknown>;
    };
    expect(event.request).toEqual({ url: 'https://api/x' });
    expect(event.user).toEqual({ id: 'u1' });
  });
});
