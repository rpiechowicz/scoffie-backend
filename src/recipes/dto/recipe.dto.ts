import { ApiProperty } from '@nestjs/swagger';

export class RecipeIngredientDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  recipeId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  unit: string;

  @ApiProperty()
  department: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class RecipeDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ required: false, nullable: true })
  description?: string | null;

  @ApiProperty({ enum: ['BREAKFAST', 'LUNCH', 'DINNER'] })
  mealType: string;

  @ApiProperty({ enum: ['EASY', 'MEDIUM', 'HARD'] })
  difficulty: string;

  @ApiProperty()
  prepTimeMinutes: number;

  @ApiProperty()
  servings: number;

  @ApiProperty({ required: false, nullable: true })
  imageUrl?: string | null;

  @ApiProperty()
  nutritionKcal: number;

  @ApiProperty()
  nutritionProtein: number;

  @ApiProperty()
  nutritionFat: number;

  @ApiProperty()
  nutritionCarbs: number;

  @ApiProperty()
  nutritionFiber: number;

  @ApiProperty()
  nutritionSalt: number;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({ default: false })
  isFavorite: boolean;

  @ApiProperty()
  authorId: string;

  @ApiProperty()
  householdId: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({ type: [RecipeIngredientDto] })
  ingredients: RecipeIngredientDto[];
}
