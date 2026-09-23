process.env.SENTRY_DSN = '';
import { scrubEvent, scrubLogMessage, scrubSpanData } from './instrument';

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

describe('scrubEvent — adres żądania', () => {
  it('ucina query i fragment z URL', () => {
    const event = scrubEvent({
      request: { url: 'https://api/x?email=a@b.pl#t' },
    } as never) as { request?: { url?: string } };
    expect(event.request?.url).toBe('https://api/x');
  });
});

describe('scrubSpanData', () => {
  it('zdejmuje query z atrybutów spanu HTTP, zostawia ścieżkę', () => {
    const data: Record<string, unknown> = {
      'url.full': 'https://api/recipes/1?token=tajne',
      'http.target': '/recipes/1?token=tajne',
      'http.query': 'token=tajne',
      'url.query': 'token=tajne',
      'http.route': '/recipes/:id',
    };
    scrubSpanData(data);
    expect(data).toEqual({
      'url.full': 'https://api/recipes/1',
      'http.target': '/recipes/1',
      'http.route': '/recipes/:id',
    });
  });
});

describe('scrubLogMessage', () => {
  it('zdejmuje IP, user-agent i query z linii logu żądania', () => {
    expect(
      scrubLogMessage(
        'GET /auth/reset?token=abc 500 12.3ms requestId=r1 userId=u1 ip=1.2.3.4 ua=Mozilla/5.0 (iPhone; CPU)',
      ),
    ).toBe('GET /auth/reset 500 12.3ms requestId=r1 userId=u1');
  });

  it('maskuje e-maile', () => {
    expect(scrubLogMessage('nie wysłano do jan.k+x@poczta.pl')).toBe(
      'nie wysłano do [email]',
    );
  });
});
