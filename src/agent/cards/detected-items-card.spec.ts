import { buildDetectedItemsCard } from './detected-items-card';

// Cała wartość tej karty siedzi w rozdziale „pewne / niepewne”. Lista
// składników, w której jedna pozycja jest zgadnięta, jest gorsza niż lista
// krótsza o tę pozycję — bo nie widać, która to.

describe('buildDetectedItemsCard', () => {
  const item = (name: string, sure = true) => ({ name, sure });

  it('pewne idą przed niepewnymi', () => {
    const card = buildDetectedItemsCard({
      items: [item('Coś w folii', false), item('Jajka'), item('Ser żółty')],
    });
    expect(card.items.map((entry) => entry.name)).toEqual([
      'Jajka',
      'Ser żółty',
      'Coś w folii',
    ]);
  });

  it('tytuł mówi, ile z tego jest niepewne', () => {
    expect(
      buildDetectedItemsCard({ items: [item('Jajka'), item('Ser')] }).title,
    ).toBe('Widzę 2 produkty');
    expect(
      buildDetectedItemsCard({
        items: [item('Jajka'), item('Coś', false)],
      }).title,
    ).toBe('Widzę 2 produkty, 1 niepewny');
    expect(
      buildDetectedItemsCard({
        items: [item('Jajka'), item('A', false), item('B', false)],
      }).title,
    ).toBe('Widzę 3 produkty, 2 niepewne');
  });

  it('da się ją poprawić, i to jest jedyna jej akcja', () => {
    const card = buildDetectedItemsCard({ items: [item('Jajka')] });
    expect(card.actions).toEqual([
      {
        type: 'ASK',
        proposalId: null,
        label: 'Popraw listę',
        style: 'SECONDARY',
        prompt: 'Popraw listę: ',
      },
    ]);
    // Rozpoznanie niczego nie zapisuje — nie ma tu stanu do kliknięcia.
    expect(card).not.toHaveProperty('state');
  });

  it('przycina do dwunastu i wyrzuca puste nazwy', () => {
    const card = buildDetectedItemsCard({
      items: [
        item('  '),
        ...Array.from({ length: 15 }, (_, index) => item(`P${index}`)),
      ],
    });
    expect(card.items).toHaveLength(12);
  });
});
