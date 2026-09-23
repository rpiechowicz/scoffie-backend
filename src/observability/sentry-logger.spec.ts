import * as Sentry from '@sentry/nestjs';
import { SentryForwardingLogger } from './sentry-logger';

describe('SentryForwardingLogger', () => {
  const warn = jest.spyOn(Sentry.logger, 'warn').mockImplementation(() => {});
  const error = jest.spyOn(Sentry.logger, 'error').mockImplementation(() => {});
  const logger = new SentryForwardingLogger();
  logger.setLogLevels([]); // bez szumu na stdout w testach

  afterEach(() => jest.clearAllMocks());

  it('wysyła warn z kontekstem loggera', () => {
    logger.warn('wolna odpowiedź', 'RequestLoggingInterceptor');
    expect(warn).toHaveBeenCalledWith('wolna odpowiedź', {
      'logger.name': 'RequestLoggingInterceptor',
    });
  });

  it('przy error bierze kontekst z końca, nie stos', () => {
    logger.error('padło', 'Error: x\n    at y', 'MailService');
    expect(error).toHaveBeenCalledWith('padło', {
      'logger.name': 'MailService',
    });
  });

  it('nie wysyła log/debug', () => {
    logger.log('GET / 200');
    logger.debug('x');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
