-- Jeden składnik występuje w przepisie najwyżej raz. Import i tak zastępuje
-- całą listę składników przepisu, a katalog nie ma duplikatów — bez tej
-- unikalności „zamień składnik X w przepisie Y” (przyszłe narzędzia asystenta,
-- edycja przepisu) byłoby niejednoznaczne. Nazwa indeksu taka, jaką Prisma
-- nadaje dla `@@unique([recipeId, ingredientId])`, żeby `migrate diff` był czysty.
CREATE UNIQUE INDEX IF NOT EXISTS "RecipeIngredient_recipeId_ingredientId_key"
  ON "RecipeIngredient"("recipeId", "ingredientId");
