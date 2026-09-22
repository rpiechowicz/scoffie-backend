-- Wersja reguł, według których zbudowano migawkę listy zakupów.
--
-- Pierwsza zmiana reguł (1: jedna jednostka na produkt — produkt ze znaną
-- masą sztuki stoi na liście zawsze w sztukach) musi dotrzeć do list już
-- policzonych. Zamiast masowego `UPDATE "ShoppingList" SET "isStale" = true`
-- migawka niesie wersję: istniejące wiersze dostają 0, kod przebudowuje każdą
-- starszą przy najbliższym odczycie i zapisuje bieżącą. Sama nowa kolumna
-- z wartością domyślną — stara wersja aplikacji jej nie widzi (rollback bez
-- migracji w dół).

ALTER TABLE "ShoppingList" ADD COLUMN "rulesVersion" INTEGER NOT NULL DEFAULT 0;
