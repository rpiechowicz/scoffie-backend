import {
  IsInt,
  IsObject,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * `POST /admin/cook/scenarios/:recipeId/publish`. Treść waliduje serwis
 * (kształt + walidatory twarde systemu pisania) — tu tylko koperta.
 */
export class PublishCookScenarioDto {
  @IsObject()
  content!: Record<string, unknown>;

  /** Wersja, którą edytowano; `null` = przepis bez żadnej wersji. */
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  basedOnVersion!: number | null;
}

/** `POST /admin/cook/scenarios/:recipeId/withdraw` — powód do audytu. */
export class WithdrawCookScenarioDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
