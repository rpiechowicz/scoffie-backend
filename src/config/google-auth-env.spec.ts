import { inspectRuntimeEnv } from './assert-env';
import {
  googleAuthEnvProblems,
  readGoogleOAuthClientIds,
} from './google-auth-env';

describe('google-auth-env', () => {
  it('lista po przecinku, bez pustych i spacji', () => {
    expect(
      readGoogleOAuthClientIds({
        GOOGLE_OAUTH_CLIENT_IDS:
          ' a.apps.googleusercontent.com ,, b.apps.googleusercontent.com ',
      }),
    ).toEqual(['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com']);
    expect(readGoogleOAuthClientIds({})).toEqual([]);
  });

  it('brak zmiennej to nie problem (endpoint po prostu wyłączony)', () => {
    expect(googleAuthEnvProblems({})).toEqual([]);
  });

  it('wpis bez sufiksu klienta Google → ostrzeżenie bez wartości', () => {
    const problems = googleAuthEnvProblems({
      GOOGLE_OAUTH_CLIENT_IDS: 'GOCSPX-sekret-klienta',
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).not.toContain('GOCSPX');
  });

  it('na produkcji zły wpis to ostrzeżenie, nigdy odmowa startu', () => {
    const report = inspectRuntimeEnv({
      NODE_ENV: 'production',
      GOOGLE_OAUTH_CLIENT_IDS: 'zly-wpis',
    });
    expect(report.warnings.join('\n')).toContain('GOOGLE_OAUTH_CLIENT_IDS');
    expect(report.violations.join('\n')).not.toContain(
      'GOOGLE_OAUTH_CLIENT_IDS',
    );
  });
});
