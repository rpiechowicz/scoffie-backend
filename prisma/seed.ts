import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$transaction([
    prisma.planItem.deleteMany(),
    prisma.weeklyPlan.deleteMany(),
    prisma.invitation.deleteMany(),
    prisma.membership.deleteMany(),
    prisma.recipe.deleteMany(),
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

  await prisma.recipe.createMany({
    data: [
      {
        title: 'Pasta with tomatoes',
        description: 'Simple pasta with tomato sauce and basil.',
        authorId: anna.id,
        householdId: home.id,
      },
      {
        title: 'Oatmeal with fruit',
        description: 'Quick breakfast to start the day.',
        authorId: anna.id,
        householdId: home.id,
      },
      {
        title: 'Chicken with rice',
        description: 'Classic lunch with vegetables.',
        authorId: anna.id,
        householdId: home.id,
      },
      {
        title: 'Greek salad',
        description: 'Tomato, cucumber, olives, feta.',
        authorId: anna.id,
        householdId: home.id,
      },
      {
        title: 'Pumpkin soup',
        description: 'Warm soup for colder days.',
        authorId: anna.id,
        householdId: home.id,
      },
    ],
  });

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
