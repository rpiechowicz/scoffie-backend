import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  await prisma.$transaction([
    prisma.recipe.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  const anna = await prisma.user.create({
    data: {
      provider: 'google',
      providerId: 'google-anna',
      displayName: 'Anna Nowak',
      avatarUrl: 'https://i.pravatar.cc/150?img=47',
    },
  });

  const jan = await prisma.user.create({
    data: {
      provider: 'apple',
      providerId: 'apple-jan',
      displayName: 'Jan Kowalski',
      avatarUrl: 'https://i.pravatar.cc/150?img=12',
    },
  });

  await prisma.recipe.createMany({
    data: [
      {
        title: 'Makaron z pomidorami',
        description: 'Prosty makaron z sosem pomidorowym i bazylią.',
        authorId: anna.id,
      },
      {
        title: 'Owsianka z owocami',
        description: 'Szybkie śniadanie na start dnia.',
        authorId: anna.id,
      },
      {
        title: 'Kurczak z ryżem',
        description: 'Klasyk na obiad z warzywami.',
        authorId: jan.id,
      },
      {
        title: 'Sałatka grecka',
        description: 'Pomidor, ogórek, oliwki, feta.',
        authorId: anna.id,
      },
      {
        title: 'Zupa krem z dyni',
        description: 'Rozgrzewająca zupa na chłodniejsze dni.',
        authorId: jan.id,
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
