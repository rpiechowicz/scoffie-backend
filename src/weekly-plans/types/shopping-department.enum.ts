/// Shopping list "department" used to group items in the UI.
/// Display strings are Polish — they match the labels iOS expects.
export enum ShoppingDepartment {
  VEGETABLES = 'Warzywa',
  FRUITS = 'Owoce',
  MEAT = 'Mięso',
  FISH = 'Ryby',
  DAIRY = 'Nabiał',
  BAKERY = 'Piekarnia',
  GRAINS = 'Zboża i makarony',
  CANNED = 'Konserwy',
  SPICES = 'Przyprawy i sosy',
  OILS = 'Olej i tłuszcze',
  ALCOHOLS = 'Alkohole',
  BEVERAGES = 'Napoje',
  SNACKS = 'Przekąski i słodycze',
  FROZEN = 'Mrożonki',
  CONFECTIONERY = 'Cukiernia',
  HOUSEHOLD = 'Chemia i gospodarstwo',
  OTHER = 'Inne',
}

/// Sort order applied to shopping list items so the UI lists them
/// in roughly the order you'd find them walking through a Polish
/// supermarket (warzywa first, chemia last).
export const DEPARTMENT_ORDER: Record<string, number> = {
  [ShoppingDepartment.VEGETABLES]: 1,
  [ShoppingDepartment.FRUITS]: 2,
  [ShoppingDepartment.MEAT]: 3,
  [ShoppingDepartment.FISH]: 4,
  [ShoppingDepartment.DAIRY]: 5,
  [ShoppingDepartment.BAKERY]: 6,
  [ShoppingDepartment.GRAINS]: 7,
  [ShoppingDepartment.CANNED]: 8,
  [ShoppingDepartment.SPICES]: 9,
  [ShoppingDepartment.OILS]: 10,
  [ShoppingDepartment.ALCOHOLS]: 11,
  [ShoppingDepartment.BEVERAGES]: 12,
  [ShoppingDepartment.SNACKS]: 13,
  [ShoppingDepartment.FROZEN]: 14,
  [ShoppingDepartment.CONFECTIONERY]: 15,
  [ShoppingDepartment.HOUSEHOLD]: 16,
  [ShoppingDepartment.OTHER]: 99,
};
