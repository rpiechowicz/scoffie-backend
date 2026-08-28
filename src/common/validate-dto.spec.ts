import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AppException } from './app-exception';
import { mapError } from './error-contract';
import { validateDto, validateWsPayload } from './validate-dto';

const DAYS = ['MON', 'TUE', 'WED'] as const;

class SlotDto {
  @IsIn(DAYS)
  dayOfWeek: string;

  @IsUUID()
  recipeId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8)
  plannedServings?: number;

  @IsOptional()
  @IsBoolean()
  isEaten?: boolean;

  @IsOptional()
  @IsUUID(undefined, { each: true })
  participantIds?: string[];
}

class FiltersDto {
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  page?: number;
}

class NestedDto {
  @ValidateNested()
  @Type(() => SlotDto)
  data: SlotDto;
}

class Envelope {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsUUID()
  householdId: string;

  @IsObject()
  data: object;
}

const UUID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

async function failure(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('validateDto', () => {
  it('poprawny payload → instancja klasy po transformacji', async () => {
    const dto = await validateDto(SlotDto, {
      dayOfWeek: 'MON',
      recipeId: UUID,
      plannedServings: 2,
    });
    expect(dto).toBeInstanceOf(SlotDto);
    expect(dto).toEqual({
      dayOfWeek: 'MON',
      recipeId: UUID,
      plannedServings: 2,
    });
  });

  it('zły enum → VALIDATION_ERROR 400 z listą dozwolonych w details', async () => {
    const error = await failure(
      validateDto(SlotDto, { dayOfWeek: 'MONDAY', recipeId: UUID }),
    );
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.getStatus()).toBe(400);
    expect(error.details).toEqual([
      'dayOfWeek must be one of the following values: MON, TUE, WED',
    ]);
    expect(error.message).toBe(error.details?.join(', '));
  });

  it('nie-UUID (pole i tablica each) → czytelne wpisy zamiast P2023', async () => {
    const error = await failure(
      validateDto(SlotDto, {
        dayOfWeek: 'MON',
        recipeId: 'r-1',
        participantIds: [UUID, 'u-2'],
      }),
    );
    expect(error.details).toEqual([
      'recipeId must be a UUID',
      'each value in participantIds must be a UUID',
    ]);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'x'],
    ['number', 42],
  ])('brak data (%s) → lista brakujących pól, nie TypeError', async (_, raw) => {
    const error = await failure(validateDto(SlotDto, raw));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual(
      expect.arrayContaining([
        'dayOfWeek must be one of the following values: MON, TUE, WED',
        'recipeId must be a UUID',
      ]),
    );
  });

  it('liczba jako string bez @Type → błąd; z @Transform → skonwertowana', async () => {
    const error = await failure(
      validateDto(SlotDto, {
        dayOfWeek: 'MON',
        recipeId: UUID,
        plannedServings: '2',
      }),
    );
    expect(error.details).toEqual(
      expect.arrayContaining(['plannedServings must be an integer number']),
    );

    const filters = await validateDto(FiltersDto, { page: '2' });
    expect(filters.page).toBe(2);
  });

  it('boolean jako string → błąd (bez niejawnej konwersji: "false" byłoby true)', async () => {
    const error = await failure(
      validateDto(SlotDto, { dayOfWeek: 'MON', recipeId: UUID, isEaten: 'false' }),
    );
    expect(error.details).toEqual(['isEaten must be a boolean value']);
  });

  it('nieznane pole → błąd (domyślnie forbidNonWhitelisted)', async () => {
    const error = await failure(
      validateDto(SlotDto, { dayOfWeek: 'MON', recipeId: UUID, dietTags: [] }),
    );
    expect(error.details).toEqual(['property dietTags should not exist']);
  });

  it('nieznane pole z forbidNonWhitelisted:false → obcięte po cichu', async () => {
    const dto = await validateDto(
      SlotDto,
      { dayOfWeek: 'MON', recipeId: UUID, dietTags: [] },
      { forbidNonWhitelisted: false },
    );
    expect(dto).toEqual({ dayOfWeek: 'MON', recipeId: UUID });
  });

  it('zagnieżdżenie → prefiks rodzica jak w ValidationPipe HTTP', async () => {
    const error = await failure(
      validateDto(NestedDto, { data: { dayOfWeek: 'MON', recipeId: 'x' } }),
    );
    expect(error.details).toEqual(['data.recipeId must be a UUID']);
  });

  it('klucze prototypu są wycinane, zanim trafią do instancji', async () => {
    const dto = await validateDto(
      SlotDto,
      JSON.parse(
        `{"dayOfWeek":"MON","recipeId":"${UUID}","__proto__":{"polluted":true}}`,
      ) as unknown,
    );
    expect((dto as unknown as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('parytet z HTTP: te same details co globalny ValidationPipe → mapError', async () => {
    const raw = {
      dayOfWeek: 'MONDAY',
      recipeId: 'r-1',
      plannedServings: '9',
      extra: 1,
    };
    const httpPipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    let httpContract: ReturnType<typeof mapError>['contract'] | undefined;
    try {
      await httpPipe.transform({ ...raw }, { type: 'body', metatype: SlotDto });
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      httpContract = mapError(error).contract;
    }
    const wsError = await failure(validateDto(SlotDto, { ...raw }));
    const wsContract = mapError(wsError).contract;

    expect(httpContract).toBeDefined();
    expect(wsContract).toEqual(httpContract);
    expect(wsContract.details?.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateWsPayload', () => {
  it('koperta: nieznane pola przechodzą (stare buildy), reszta walidowana', async () => {
    const payload = await validateWsPayload(Envelope, {
      userId: 'legacy',
      householdId: UUID,
      data: { anything: 1 },
      staleField: true,
    });
    expect(payload).toEqual({
      userId: 'legacy',
      householdId: UUID,
      data: { anything: 1 },
    });
  });

  it.each([
    ['brak payloadu', undefined, ['householdId must be a UUID', 'data must be an object']],
    ['householdId nie-UUID', { householdId: 'hh-1', data: {} }, ['householdId must be a UUID']],
    ['data nie-obiekt', { householdId: UUID, data: 'x' }, ['data must be an object']],
    ['brak data', { householdId: UUID }, ['data must be an object']],
  ])('%s → VALIDATION_ERROR', async (_, raw, details) => {
    const error = await failure(validateWsPayload(Envelope, raw));
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual(details);
  });

  it('zawartość data nie jest walidowana ani obcinana na kopercie (robi to serwis)', async () => {
    const payload = await validateWsPayload(Envelope, {
      householdId: UUID,
      data: { dayOfWeek: 'MONDAY', unknown: 1 },
    });
    expect(payload.data).toEqual({ dayOfWeek: 'MONDAY', unknown: 1 });
  });
});
