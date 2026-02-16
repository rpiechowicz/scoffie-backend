import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ł]/g, 'l')
    .replace(/[ą]/g, 'a')
    .replace(/[ć]/g, 'c')
    .replace(/[ę]/g, 'e')
    .replace(/[ń]/g, 'n')
    .replace(/[ó]/g, 'o')
    .replace(/[ś]/g, 's')
    .replace(/[ź]/g, 'z')
    .replace(/[ż]/g, 'z')
    .trim()
    .replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  await prisma.$transaction([
    prisma.planItem.deleteMany(),
    prisma.weeklyPlan.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.recipe.deleteMany(),
    prisma.ingredientAlias.deleteMany(),
    prisma.ingredient.deleteMany(),
    prisma.household.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  const anna = await prisma.user.create({
    data: {
      googleId: 'google-anna',
      displayName: 'Anna Nowak',
      email: 'anna@example.com',
      avatarUrl: 'https://i.pravatar.cc/150?img=47',
    },
  });

  const home = await prisma.household.create({
    data: {
      name: 'Home',
      createdById: anna.id,
      memberships: {
        create: [
          {
            userId: anna.id,
            role: 'OWNER',
          },
        ],
      },
      invitations: {
        create: [
          {
            token: 'invite-home-demo',
            createdById: anna.id,
            expiresAt: new Date('2026-12-31T23:59:59.000Z'),
          },
        ],
      },
    },
  });

  const recipesToCreate = [
    {
      title: 'Pasta with tomatoes',
      description: 'Simple pasta with tomato sauce and basil.',
      mealType: 'DINNER' as const,
      difficulty: 'EASY' as const,
      prepTimeMinutes: 25,
      servings: 2,
      nutritionKcal: 820,
      nutritionProtein: 28,
      nutritionFat: 18,
      nutritionCarbs: 130,
      nutritionFiber: 8,
      nutritionSalt: 2.1,
      ingredients: [
        { name: 'Pasta', amount: 220, unit: 'g', department: 'Zboża i makarony' },
        { name: 'Tomatoes', amount: 300, unit: 'g', department: 'Warzywa' },
        { name: 'Basil', amount: 10, unit: 'g', department: 'Warzywa' },
      ],
    },
    {
      title: 'Oatmeal with fruit',
      description: 'Quick breakfast to start the day.',
      mealType: 'BREAKFAST' as const,
      difficulty: 'EASY' as const,
      prepTimeMinutes: 10,
      servings: 2,
      nutritionKcal: 640,
      nutritionProtein: 20,
      nutritionFat: 10,
      nutritionCarbs: 110,
      nutritionFiber: 9,
      nutritionSalt: 0.6,
      ingredients: [
        { name: 'Oats', amount: 100, unit: 'g', department: 'Zboża i makarony' },
        { name: 'Milk', amount: 300, unit: 'ml', department: 'Nabiał' },
        { name: 'Banana', amount: 1, unit: 'szt', department: 'Owoce' },
      ],
    },
    {
      title: 'Chicken with rice',
      description: 'Classic lunch with vegetables.',
      mealType: 'LUNCH' as const,
      difficulty: 'MEDIUM' as const,
      prepTimeMinutes: 30,
      servings: 2,
      nutritionKcal: 980,
      nutritionProtein: 62,
      nutritionFat: 22,
      nutritionCarbs: 120,
      nutritionFiber: 7,
      nutritionSalt: 1.8,
      ingredients: [
        { name: 'Chicken breast', amount: 300, unit: 'g', department: 'Mięso' },
        { name: 'Rice', amount: 180, unit: 'g', department: 'Zboża i makarony' },
        { name: 'Broccoli', amount: 200, unit: 'g', department: 'Warzywa' },
      ],
    },
    {
      title: 'Greek salad',
      description: 'Tomato, cucumber, olives, feta.',
      mealType: 'LUNCH' as const,
      difficulty: 'EASY' as const,
      prepTimeMinutes: 15,
      servings: 2,
      nutritionKcal: 520,
      nutritionProtein: 18,
      nutritionFat: 36,
      nutritionCarbs: 24,
      nutritionFiber: 6,
      nutritionSalt: 2.7,
      ingredients: [
        { name: 'Tomato', amount: 220, unit: 'g', department: 'Warzywa' },
        { name: 'Cucumber', amount: 180, unit: 'g', department: 'Warzywa' },
        { name: 'Feta', amount: 120, unit: 'g', department: 'Nabiał' },
      ],
    },
    {
      title: 'Pumpkin soup',
      description: 'Warm soup for colder days.',
      mealType: 'DINNER' as const,
      difficulty: 'EASY' as const,
      prepTimeMinutes: 35,
      servings: 4,
      nutritionKcal: 760,
      nutritionProtein: 18,
      nutritionFat: 24,
      nutritionCarbs: 108,
      nutritionFiber: 12,
      nutritionSalt: 2.2,
      ingredients: [
        { name: 'Pumpkin', amount: 900, unit: 'g', department: 'Warzywa' },
        { name: 'Vegetable stock', amount: 1200, unit: 'ml', department: 'Konserwy' },
        { name: 'Cream', amount: 120, unit: 'ml', department: 'Nabiał' },
      ],
    },
  ];

  for (const recipe of recipesToCreate) {
    const ingredientRows = await Promise.all(
      recipe.ingredients.map(async (ingredient) =>
        prisma.ingredient.upsert({
          where: { normalizedName: normalizeText(ingredient.name) },
          update: {
            name: ingredient.name,
            category: ingredient.department,
            isActive: true,
          },
          create: {
            name: ingredient.name,
            normalizedName: normalizeText(ingredient.name),
            category: ingredient.department,
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            category: true,
          },
        }),
      ),
    );

    const ingredientMap = new Map(ingredientRows.map((ingredient) => [ingredient.name, ingredient]));

    await prisma.recipe.create({
      data: {
        title: recipe.title,
        description: recipe.description,
        mealType: recipe.mealType,
        difficulty: recipe.difficulty,
        prepTimeMinutes: recipe.prepTimeMinutes,
        servings: recipe.servings,
        nutritionKcal: recipe.nutritionKcal,
        nutritionProtein: recipe.nutritionProtein,
        nutritionFat: recipe.nutritionFat,
        nutritionCarbs: recipe.nutritionCarbs,
        nutritionFiber: recipe.nutritionFiber,
        nutritionSalt: recipe.nutritionSalt,
        authorId: anna.id,
        householdId: home.id,
        ingredients: {
          create: recipe.ingredients.map((ingredient) => ({
            ingredientId: ingredientMap.get(ingredient.name)!.id,
            name: ingredient.name,
            amount: ingredient.amount,
            unit: ingredient.unit,
            normalizedAmount: ingredient.amount,
            normalizedUnit: ingredient.unit,
            department: ingredient.department,
          })),
        },
      },
    });
  }

  const weeklyPlan = await prisma.weeklyPlan.create({
    data: {
      householdId: home.id,
      weekStart: new Date('2026-01-26T00:00:00.000Z'),
    },
  });

  const recipeList = await prisma.recipe.findMany({
    where: { householdId: home.id },
    orderBy: { createdAt: 'asc' },
  });

  await prisma.planItem.createMany({
    data: [
      {
        weeklyPlanId: weeklyPlan.id,
        recipeId: recipeList[0].id,
        dayOfWeek: 'MON',
        mealType: 'DINNER',
      },
      {
        weeklyPlanId: weeklyPlan.id,
        recipeId: recipeList[1].id,
        dayOfWeek: 'TUE',
        mealType: 'BREAKFAST',
      },
      {
        weeklyPlanId: weeklyPlan.id,
        recipeId: recipeList[2].id,
        dayOfWeek: 'WED',
        mealType: 'LUNCH',
      },
    ],
  });
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
