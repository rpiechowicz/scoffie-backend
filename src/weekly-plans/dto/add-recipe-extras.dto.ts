import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * „Brakuje mi" ze szczegółu przepisu: które składniki dopisać do listy
 * zakupów i na ile porcji. Walidowane w serwisie przez `validateDto`.
 *
 * Telefon wysyła WYŁĄCZNIE identyfikatory — ilość, jednostkę, nazwę i dział
 * serwer bierze z `RecipeIngredient`, tak samo jak przy liczeniu listy
 * z planu. Liczby z klienta rozjechałyby się z tymi z planu przy pierwszym
 * zaokrągleniu, a pod jednym `productKey` muszą się sumować.
 */
export class AddRecipeExtrasDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  @IsUUID()
  recipeId: string;

  /** Te same widełki co `plannedServings` w planie. */
  @ApiProperty({ example: 2, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  servings: number;

  /** `RecipeIngredient.id` brakujących składników. */
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  ingredientIds: string[];
}
