import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNumber, IsUUID, Max, Min } from 'class-validator';

/**
 * `weeklyPlans:setPortion` — porcja JEDNEJ osoby w pozycji z alokacją
 * (ADR `plan-portions-safe-editing`). Porcje innych osób nie są zapisywane,
 * więc edycje różnych osób nie kolidują; nadpisanie tej samej osoby chroni
 * `expectedRevision` (stempel JEJ porcji z odczytu).
 */
export class SetPortionDto {
  /** `items[].id` z odczytu tygodnia. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planItemId: string;

  /** Czyja porcja. */
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId: string;

  /** Nowa porcja tej osoby (wartość bezwzględna), wielokrotność 0,05. */
  @ApiProperty({ example: 1.25, minimum: 0.1, maximum: 6 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.1)
  @Max(6)
  servings: number;

  /** `items[].portions[].revision` tej osoby z odczytu. */
  @ApiProperty({ example: 7, minimum: 0 })
  @IsInt()
  @Min(0)
  expectedRevision: number;
}
