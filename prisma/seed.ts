import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$transaction([
    prisma.recipe.deleteMany(),
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

  await prisma.recipe.createMany({
    data: [
      {
        title: 'Pasta with tomatoes',
        description: 'Simple pasta with tomato sauce and basil.',
        authorId: anna.id,
      },
      {
        title: 'Oatmeal with fruit',
        description: 'Quick breakfast to start the day.',
        authorId: anna.id,
      },
      {
        title: 'Chicken with rice',
        description: 'Classic lunch with vegetables.',
        authorId: anna.id,
      },
      {
        title: 'Greek salad',
        description: 'Tomato, cucumber, olives, feta.',
        authorId: anna.id,
      },
      {
        title: 'Pumpkin soup',
        description: 'Warm soup for colder days.',
        authorId: anna.id,
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
