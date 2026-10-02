import {
  appVersionStatus,
  compareVersions,
  parseMinVersionStrict,
  readMinVersion,
} from './app-version';
import { setRuntimeOverrides } from './runtime-overrides';
import { RUNTIME_SETTINGS } from './runtime-settings';

describe('minimalna wersja aplikacji', () => {
  afterEach(() => setRuntimeOverrides({}));

  it('porównuje po segmentach, brakujący segment = 0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1', '1.0.1')).toBe(-1);
    expect(compareVersions('1.10', '1.9')).toBe(1);
    expect(compareVersions('2.0', '1.99.99')).toBe(1);
  });

  it('próg: pusty i off = bez progu, śmieci = błąd', () => {
    expect(parseMinVersionStrict('')).toBeNull();
    expect(parseMinVersionStrict(' OFF ')).toBeNull();
    expect(parseMinVersionStrict('1.0.2')).toBe('1.0.2');
    expect(parseMinVersionStrict('1.0.2-beta')).toBeUndefined();
    expect(parseMinVersionStrict('v1')).toBeUndefined();
  });

  it('za stara wersja = updateRequired, równa i nowsza przechodzą', () => {
    const env = { APP_MIN_VERSION_IOS: '1.1' };
    expect(appVersionStatus('ios', '1.0', env).updateRequired).toBe(true);
    expect(appVersionStatus('ios', '1.1', env).updateRequired).toBe(false);
    expect(appVersionStatus('ios', '1.1.0', env).updateRequired).toBe(false);
    expect(appVersionStatus('ios', '1.2', env)).toEqual({
      platform: 'ios',
      minVersion: '1.1',
      updateRequired: false,
      storeUrl: 'https://apps.apple.com/app/id6808608589',
    });
  });

  it('wszystko nieczytelne PRZEPUSZCZA — literówka nie zamyka aplikacji', () => {
    expect(appVersionStatus('ios', '1.0', {}).updateRequired).toBe(false);
    expect(
      appVersionStatus('ios', '1.0', { APP_MIN_VERSION_IOS: '1.x' })
        .updateRequired,
    ).toBe(false);
    const env = { APP_MIN_VERSION_IOS: '2.0' };
    expect(appVersionStatus('ios', undefined, env).updateRequired).toBe(false);
    expect(appVersionStatus('ios', 'abc', env).updateRequired).toBe(false);
  });

  it('platformy mają osobne progi', () => {
    const env = { APP_MIN_VERSION_IOS: '2.0' };
    expect(appVersionStatus('ios', '1.0', env).updateRequired).toBe(true);
    expect(appVersionStatus('android', '1.0', env).updateRequired).toBe(false);
  });

  it('próg z panelu wygrywa z env i jest walidowany', () => {
    const spec = RUNTIME_SETTINGS.APP_MIN_VERSION_ANDROID;
    expect(spec.kind).toBe('version');
    expect(spec.normalize('1.2.3')).toEqual({ ok: true, value: '1.2.3' });
    expect(spec.normalize('')).toEqual({ ok: true, value: 'off' });
    expect(spec.normalize('jutro').ok).toBe(false);

    setRuntimeOverrides({ APP_MIN_VERSION_ANDROID: '1.4' });
    expect(readMinVersion('android')).toBe('1.4');
    expect(spec.effective({} as never)).toBe('1.4');
    setRuntimeOverrides({ APP_MIN_VERSION_ANDROID: 'off' });
    expect(readMinVersion('android')).toBeNull();
  });
});
