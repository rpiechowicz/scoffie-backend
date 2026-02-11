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

  @ApiProperty({ required: false, nullable: true })
  sourceProvider?: string | null;

  @ApiProperty({ required: false, nullable: true })
  sourceRecipeId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  sourceCategory?: string | null;

  @ApiProperty({ required: false, nullable: true })
  sourceCuisine?: string | null;

  @ApiProperty({ type: [String], default: [] })
  sourceTags: string[];

  @ApiProperty({ required: false, nullable: true })
  sourceMeta?: Record<string, unknown> | null;

  @ApiProperty({ required: false, nullable: true })
  sourceDietary?: Record<string, unknown> | null;

  @ApiProperty({ required: false, nullable: true })
  sourceStorage?: Record<string, unknown> | null;

  @ApiProperty({ required: false, nullable: true })
  sourceEquipment?: unknown[] | null;

  @ApiProperty({ required: false, nullable: true })
  sourceInstructions?: unknown[] | null;

  @ApiProperty({ required: false, nullable: true })
  sourceTroubleshooting?: unknown[] | null;

  @ApiProperty({ required: false, nullable: true })
  sourceChefNotes?: string[] | null;

  @ApiProperty({ required: false, nullable: true })
  sourceCulturalContext?: string | null;

  @ApiProperty({ required: false, nullable: true })
  sourceNutrition?: Record<string, unknown> | null;

  @ApiProperty({ required: false, nullable: true })
  sourceRaw?: Record<string, unknown> | null;

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
