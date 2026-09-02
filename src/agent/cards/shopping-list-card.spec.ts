import { buildShoppingListCard } from './shopping-list-card';
import { ShoppingDepartment } from '../../weekly-plans/types/shopping-department.enum';

// Ta karta jest jedyną, przy której makieta obiecywała więcej, niż aplikacja
// wie: „pozostałe 14 rzeczy masz w spiżarni”. Spiżarni nie ma. Testy pilnują,
// żeby karta mówiła dokładnie tyle, ile serwer potrafi policzyć.

const order = Object.values(ShoppingDepartment);

const item = (over: Record<string, unknown> = {}) => ({
  name: 'Feta',
  unit: 'op.',
  department: ShoppingDepartment.DAIRY,
  totalAmount: 2,
  isChecked: false,
  ...over,
});

describe('buildShoppingListCard', () => {
  it('grupuje po działach w kolejności sklepu, nie planu', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [
        item({
          name: 'Kasza',
          department: ShoppingDepartment.GRAINS,
          unit: 'g',
          totalAmount: 500,
        }),
        item({
          name: 'Cukinia',
          department: ShoppingDepartment.VEGETABLES,
          unit: 'szt.',
          totalAmount: 2,
        }),
        item(),
      ],
    });

    expect(card.groups.map((group) => group.department)).toEqual([
      ShoppingDepartment.VEGETABLES,
      ShoppingDepartment.DAIRY,
      ShoppingDepartment.GRAINS,
    ]);
    expect(card.groups[1].items).toEqual(['Feta 2 op.']);
    expect(card.title).toBe('3 rzeczy do kupienia');
  });

  it('odhaczone znikają z listy, ale nie z rachunku', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item(), item({ name: 'Jogurt', isChecked: true })],
    });

    expect(card.summary).toEqual({ remaining: 1, checked: 1 });
    expect(card.checkedNote).toBe('1 pozycja już odhaczona');
    expect(card.groups.flatMap((group) => group.items)).toEqual(['Feta 2 op.']);
  });

  it('odmiana idzie za liczbą, a nie tylko rzeczownik', () => {
    const note = (checked: number) =>
      buildShoppingListCard({
        weekStart: '2026-08-31',
        departmentOrder: order,
        items: [
          item(),
          ...Array.from({ length: checked }, (_, index) =>
            item({ name: `X${index}`, isChecked: true }),
          ),
        ],
      }).checkedNote;

    expect(note(1)).toBe('1 pozycja już odhaczona');
    expect(note(3)).toBe('3 pozycje już odhaczone');
    expect(note(5)).toBe('5 pozycji już odhaczonych');
    expect(note(12)).toBe('12 pozycji już odhaczonych');
  });

  it('nic do kupienia to nie jest pusta karta', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item({ isChecked: true })],
    });
    expect(card.title).toBe('Wszystko odhaczone');
    expect(card.groups).toEqual([]);
  });

  it('nieznany dział ląduje na końcu, a nie wypada z listy', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item({ name: 'Coś', department: 'Dział spoza enuma' }), item()],
    });
    expect(card.groups.map((group) => group.department)).toEqual([
      ShoppingDepartment.DAIRY,
      'Dział spoza enuma',
    ]);
  });

  it('ilości ułamkowe zaokrągla do czegoś, co da się kupić', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item({ name: 'Mąka', unit: 'kg', totalAmount: 0.2857 })],
    });
    expect(card.groups[0].items).toEqual(['Mąka 0,3 kg']);
  });

  it('bez ilości pokazuje samą nazwę, a nie „Sól 0”', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item({ name: 'Sól', unit: 'g', totalAmount: 0 })],
    });
    expect(card.groups[0].items).toEqual(['Sól']);
  });

  it('nie ma żadnej akcji, która zapisuje — lista bierze się z planu', () => {
    const card = buildShoppingListCard({
      weekStart: '2026-08-31',
      departmentOrder: order,
      items: [item()],
    });
    expect(card.actions).toEqual([
      {
        type: 'OPEN_SHOPPING',
        proposalId: null,
        label: 'Otwórz listę zakupów',
        style: 'PRIMARY',
      },
    ]);
    expect(card).not.toHaveProperty('state');
  });
});
