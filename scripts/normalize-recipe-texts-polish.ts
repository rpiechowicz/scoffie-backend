import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type RecipeTextPatch = {
  title: string;
  description: string;
  steps: string[];
};

const PATCHES_BY_LEGACY_TITLE: Record<string, RecipeTextPatch> = {
  'Owsianka z bananem i borowka': {
    title: 'Owsianka z bananem i borówką',
    description:
      'Kremowa owsianka na mleku z dodatkiem banana i borówki. Śniadanie jest szybkie, sycące i dobre na codzienny start.',
    steps: [
      'Wlej mleko do garnka i podgrzej na średnim ogniu. Wsyp płatki owsiane i mieszaj, aby nic nie przywarło.',
      'Gotuj 5-6 minut, aż owsianka zgęstnieje. W razie potrzeby dodaj odrobinę mleka.',
      'Pokrój banana i dorzuć połowę do garnka. Delikatnie wymieszaj dla naturalnej słodyczy.',
      'Przełóż owsiankę do misek i dodaj borówkę oraz resztę banana. Podawaj od razu na ciepło.',
    ],
  },
  'Jajecznica ze szczypiorkiem i pomidorem': {
    title: 'Jajecznica ze szczypiorkiem i pomidorem',
    description:
      'Klasyczna jajecznica z masłem i świeżym szczypiorkiem. Prosty pomidor z boku dodaje świeżości i równoważy smak.',
    steps: [
      'Roztrzep jajko w misce z solą i pieprzem. Posiekaj szczypiorek i pokrój pomidor.',
      'Rozpuść masło na patelni na małym ogniu. Wlej jajko i mieszaj powoli.',
      'Smaż do ulubionej konsystencji, nie przesuszaj. Dodaj szczypiorek pod koniec smażenia.',
      'Przełóż jajecznicę na talerz i podawaj z pomidorem. Danie najlepiej smakuje od razu po przygotowaniu.',
    ],
  },
  'Kanapka z twarozkiem i ogorkiem': {
    title: 'Kanapka z twarożkiem i ogórkiem',
    description:
      'Świeża kanapka z kremowym twarożkiem i chrupiącym ogórkiem. To lekkie śniadanie, które robi się w kilka minut.',
    steps: [
      'Pokrój chleb i lekko go podpiecz, jeśli lubisz chrupiącą wersję. Ogórek pokrój w cienkie plasterki.',
      'Wymieszaj twarożek z odrobiną soli i pieprzu. Dodaj posiekany szczypiorek dla aromatu.',
      'Posmaruj pieczywo twarożkiem. Ułóż na wierzchu ogórek i dodatkowy szczypiorek.',
      'Podawaj od razu po przygotowaniu. Kanapki najlepiej smakują na świeżo.',
    ],
  },
  'Omlet ze szpinakiem i feta': {
    title: 'Omlet ze szpinakiem i fetą',
    description:
      'Puszysty omlet z dodatkiem szpinaku i sera feta. Smak jest wyraźny, a przygotowanie zajmuje tylko chwilę.',
    steps: [
      'Roztrzep jajko z odrobiną soli i pieprzu. Rozgrzej patelnię z małą ilością oleju.',
      'Wrzuć szpinak i podsmaż minutę, aż lekko zwiędnie. Wlej masę jajeczną i zmniejsz ogień.',
      'Dodaj pokruszony ser feta na wierzch omletu. Smaż do momentu, aż masa się zetnie.',
      'Złóż omlet na pół i podawaj od razu. Możesz podać z pomidorem obok.',
    ],
  },
  'Tost z awokado i jajkiem': {
    title: 'Tost z awokado i jajkiem',
    description:
      'Chrupiący tost z kremowym awokado i jajkiem sadzonym. To proste śniadanie, które syci i dobrze smakuje o każdej porze dnia.',
    steps: [
      'Podpiecz chleb tostowy na złoty kolor. W międzyczasie rozgnieć awokado widelcem i dopraw szczyptą soli.',
      'Usmaż jajko na niewielkiej ilości oleju, tak aby białko było ścięte. Żółtko możesz zostawić lekko płynne.',
      'Posmaruj tosty awokado i połóż na nich jajko. Dodaj pokrojone pomidory koktajlowe obok.',
      'Dopraw pieprzem i podawaj od razu po przygotowaniu. Danie najlepiej smakuje na ciepło.',
    ],
  },
};

async function main() {
  const recipes = await prisma.recipe.findMany({
    select: { id: true, title: true, sourceInstructions: true },
  });

  let updated = 0;
  for (const recipe of recipes) {
    const patch = PATCHES_BY_LEGACY_TITLE[recipe.title];
    if (!patch) continue;

    await prisma.recipe.update({
      where: { id: recipe.id },
      data: {
        title: patch.title,
        description: patch.description,
        sourceInstructions: patch.steps.map((text, index) => ({
          step: index + 1,
          text,
        })),
      },
    });
    updated += 1;
  }

  console.log(`[normalize-recipe-texts] done. updated=${updated}`);
}

main()
  .catch((error) => {
    console.error('Recipe text normalization failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
