import { AppException } from './app-exception';
import { assertUuid, isUuid } from './uuid';

describe('uuid', () => {
  it.each([
    ['v4', '3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    [
      'ręczne id katalogu (v4-kształtne)',
      '22222222-2222-4222-8222-222222222222',
    ],
    ['wielkie litery', '3FA85F64-5717-4562-B3FC-2C963F66AFA6'],
    ['nil', '00000000-0000-0000-0000-000000000000'],
  ])('isUuid akceptuje %s', (_, value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    ['obcięte', '3fa85f64-5717-4562-b3fc'],
    ['fixture', 'hh-1'],
    ['zły wariant (bity 8-b)', '11111111-1111-1111-1111-111111111111'],
    ['puste', ''],
    ['z białym znakiem', ' 3fa85f64-5717-4562-b3fc-2c963f66afa6'],
    ['nie-string', 42],
    ['undefined', undefined],
    ['null', null],
  ])('isUuid odrzuca %s', (_, value) => {
    expect(isUuid(value)).toBe(false);
  });

  it('assertUuid oddaje wartość', () => {
    expect(
      assertUuid('22222222-2222-4222-8222-222222222222', 'householdId'),
    ).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('assertUuid → VALIDATION_ERROR 400 z nazwą pola w details (styl class-validator)', () => {
    let caught: unknown;
    try {
      assertUuid('hh-1', 'householdId');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppException);
    const error = caught as AppException;
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual(['householdId must be a UUID']);
    expect(error.message).toBe('householdId must be a UUID');
  });
});
