import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PHRASE_REPLACEMENTS: Array<[string, string]> = [
  ['brokul mrozony', 'brokuł mrożony'],
  ['brzoskwinia z puszki', 'brzoskwinia z puszki'],
  ['chleb zytni', 'chleb żytni'],
  ['kielbasa biala', 'kiełbasa biała'],
  ['kielbasa krakowska', 'kiełbasa krakowska'],
  ['kielbasa slaska', 'kiełbasa śląska'],
  ['kielbasa wedzona', 'kiełbasa wędzona'],
  ['kurczak mielony', 'kurczak mielony'],
  ['lopatka wieprzowa', 'łopatka wieprzowa'],
  ['lopatka wieprzowa mielona', 'łopatka wieprzowa mielona'],
  ['maka pelnoziarnista', 'mąka pełnoziarnista'],
  ['maka pszenna', 'mąka pszenna'],
  ['maka ziemniaczana', 'mąka ziemniaczana'],
  ['margaryna roslinna', 'margaryna roślinna'],
  ['maslo klarowane', 'masło klarowane'],
  ['mleko migdalowe', 'mleko migdałowe'],
  ['ogorek konserwowy', 'ogórek konserwowy'],
  ['ogorek kiszony', 'ogórek kiszony'],
  ['olej slonecznikowy', 'olej słonecznikowy'],
  ['orzech wloski', 'orzech włoski'],
  ['papryka slodka mielona', 'papryka słodka mielona'],
  ['poledwica wolowa', 'polędwica wołowa'],
  ['poledwiczka wieprzowa', 'polędwiczka wieprzowa'],
  ['pomarancza czerwona', 'pomarańcza czerwona'],
  ['proszek do pieczenia', 'proszek do pieczenia'],
  ['pstrag', 'pstrąg'],
  ['ryz bialy', 'ryż biały'],
  ['ryz basmati', 'ryż basmati'],
  ['ryz brazowy', 'ryż brązowy'],
  ['ryz jasminowy', 'ryż jaśminowy'],
  ['sok pomaranczowy', 'sok pomarańczowy'],
  ['smietana 12', 'śmietana 12'],
  ['smietana 18', 'śmietana 18'],
  ['smietanka 12', 'śmietanka 12'],
  ['smietanka 18', 'śmietanka 18'],
  ['smietanka 30', 'śmietanka 30'],
  ['twarozek', 'twarożek'],
  ['wieprzowina i wolowina mielona', 'wieprzowina i wołowina mielona'],
  ['wieprzowina mielona tlusta', 'wieprzowina mielona tłusta'],
  ['wolowina', 'wołowina'],
  ['wolowina mielona', 'wołowina mielona'],
  ['woda gazowana', 'woda gazowana'],
  ['woda niegazowana', 'woda niegazowana'],
  ['zurawina', 'żurawina'],
];

const TOKEN_REPLACEMENTS: Array<[string, string]> = [
  ['baklazan', 'bakłażan'],
  ['biala', 'biała'],
  ['biale', 'białe'],
  ['bialko', 'białko'],
  ['bialkowy', 'białkowy'],
  ['bialy', 'biały'],
  ['borowka', 'borówka'],
  ['brazowy', 'brązowy'],
  ['brokul', 'brokuł'],
  ['bulka', 'bułka'],
  ['czeresnia', 'czereśnia'],
  ['draze', 'draże'],
  ['drozdz', 'drożdż'],
  ['drozdzowka', 'drożdżówka'],
  ['jablko', 'jabłko'],
  ['jarmuz', 'jarmuż'],
  ['jezyna', 'jeżyna'],
  ['karkowka', 'karkówka'],
  ['kielbasa', 'kiełbasa'],
  ['lopatka', 'łopatka'],
  ['losos', 'łosoś'],
  ['maka', 'mąka'],
  ['maslo', 'masło'],
  ['maslanka', 'maślanka'],
  ['mietowa', 'miętowa'],
  ['mrozony', 'mrożony'],
  ['mrozona', 'mrożona'],
  ['mrozone', 'mrożone'],
  ['ogorek', 'ogórek'],
  ['paczek', 'pączek'],
  ['parowka', 'parówka'],
  ['poledwica', 'polędwica'],
  ['poledwiczka', 'polędwiczka'],
  ['pomarancza', 'pomarańcza'],
  ['polslodkie', 'półsłodkie'],
  ['polwytrawne', 'półwytrawne'],
  ['pstrag', 'pstrąg'],
  ['recznik', 'ręcznik'],
  ['platki', 'płatki'],
  ['ryz', 'ryż'],
  ['sol', 'sól'],
  ['salata', 'sałata'],
  ['sledz', 'śledź'],
  ['slaska', 'śląska'],
  ['slodka', 'słodka'],
  ['slodkie', 'słodkie'],
  ['slodki', 'słodki'],
  ['slony', 'słony'],
  ['slonecznik', 'słonecznik'],
  ['smietana', 'śmietana'],
  ['smietanka', 'śmietanka'],
  ['tluszcz', 'tłuszcz'],
  ['tlusta', 'tłusta'],
  ['tunczyk', 'tuńczyk'],
  ['twarog', 'twaróg'],
  ['twarozek', 'twarożek'],
  ['wegorz', 'węgorz'],
  ['wisnia', 'wiśnia'],
  ['wloski', 'włoski'],
  ['wloska', 'włoska'],
  ['wolowina', 'wołowina'],
  ['zolty', 'żółty'],
  ['zolta', 'żółta'],
  ['zurawina', 'żurawina'],
  ['zytni', 'żytni'],
  ['zytnie', 'żytnie'],
];

function applyPolishName(name: string): string {
  let value = name.toLowerCase().trim();

  for (const [from, to] of PHRASE_REPLACEMENTS) {
    value = value.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  for (const [from, to] of TOKEN_REPLACEMENTS) {
    value = value.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  }

  return value.replace(/\s+/g, ' ').trim();
}

async function main() {
  const ingredients = await prisma.ingredient.findMany({
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });

  let updated = 0;
  let conflicts = 0;
  for (const ingredient of ingredients) {
    const nextName = applyPolishName(ingredient.name);
    if (!nextName || nextName === ingredient.name) continue;

    const existing = await prisma.ingredient.findUnique({
      where: { name: nextName },
      select: { id: true },
    });
    if (existing && existing.id !== ingredient.id) {
      conflicts += 1;
      // eslint-disable-next-line no-console
      console.warn(`[normalize] conflict skipped: "${ingredient.name}" -> "${nextName}"`);
      continue;
    }

    await prisma.$transaction([
      prisma.ingredient.update({
        where: { id: ingredient.id },
        data: { name: nextName },
      }),
      prisma.ingredientAlias.upsert({
        where: { alias: ingredient.name },
        update: {},
        create: { ingredientId: ingredient.id, alias: ingredient.name },
      }),
    ]);
    updated += 1;
  }

  await prisma.$executeRawUnsafe(`
    UPDATE "RecipeIngredient" ri
    SET "name" = i."name", "department" = i."category"
    FROM "Ingredient" i
    WHERE ri."ingredientId" = i."id";
  `);

  // eslint-disable-next-line no-console
  console.log(`[normalize] done. updated=${updated}, conflicts=${conflicts}`);
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('Normalize ingredients failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
