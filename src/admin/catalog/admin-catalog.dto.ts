import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** `GET /admin/catalog/recipes?active=true|false` — bez parametru cały katalog. */
export class CatalogRecipesQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';
}

/** `POST /admin/catalog/recipes/:id/active` — wycofanie albo przywrócenie z powodem. */
export class RecipeActiveDto {
  @IsBoolean()
  isActive!: boolean;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
