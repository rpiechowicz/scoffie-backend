import { normalizeText } from '../../common/normalize-text.util';
import {
  FOLD_MAP,
  containsPattern,
  foldLikeSql,
  normalizeQuery,
} from './admin-text-search';

describe('wyszukiwanie bez polskich znaków', () => {
  it('składanie po stronie SQL daje to samo, co normalizeText', () => {
    for (const name of [
      'Anna Łódzka',
      'ZOË Müller',
      'Świętosław  Żółć-Wąs',
      'Ćma Ńuń ĘĄ',
      'ﬁrma Ødegaard',
    ]) {
      expect(foldLikeSql(name).trim()).toBe(normalizeText(name));
    }
  });

  it('mapa ma polskie litery w obu wielkościach i jest równej długości', () => {
    expect(FOLD_MAP.from.length).toBe(FOLD_MAP.to.length);
    for (const [letter, ascii] of [
      ['Ł', 'l'],
      ['ł', 'l'],
      ['Ż', 'z'],
      ['ź', 'z'],
      ['Ó', 'o'],
      ['é', 'e'],
    ]) {
      expect(FOLD_MAP.to[FOLD_MAP.from.indexOf(letter)]).toBe(ascii);
    }
  });

  it('za krótkie zapytanie nie szuka niczego', () => {
    expect(normalizeQuery(undefined)).toBeNull();
    expect(normalizeQuery('   ')).toBeNull();
    expect(normalizeQuery(' Ł ')).toBeNull();
    expect(normalizeQuery('Łó')).toBe('lo');
    expect(normalizeQuery('  Anna   Łódzka ')).toBe('anna lodzka');
  });

  it('%, _ i \\ w zapytaniu to zwykłe znaki, nie wieloznaczniki', () => {
    expect(containsPattern('50%_x\\')).toBe('%50\\%\\_x\\\\%');
    expect(containsPattern('anna')).toBe('%anna%');
  });
});
