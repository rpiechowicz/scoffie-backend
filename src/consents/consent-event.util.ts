import { Prisma } from '@prisma/client';
import {
  ConsentAction,
  ConsentKind,
  LEGAL_DOCUMENT_VERSIONS,
} from '../common/legal-documents';

/**
 * Wpis dziennika zgód W TRANSAKCJI zapisu, który go uzasadnia (review
 * 7.10.2026). `ConsentsService.recordSystem` pisze poza transakcją i po cichu
 * połyka błąd — dobre dla zdarzeń „przy okazji”, złe tam, gdzie kolejność
 * GRANTED/REVOKED musi iść za kolejnością zapisów (Cookidoo: podłączenie
 * kontra wyjście z domu). Tu wpis i zapis stają się widoczne RAZEM, a dwie
 * transakcje szeregowane blokadą zapisują wpisy w kolejności commitów.
 *
 * Ograniczenie: dziennik wybiera ostatni wpis po `createdAt` (z zegara
 * procesu), a przy remisie w tej samej milisekundzie po `id` (losowe uuid).
 * Wpis transakcji czekającej na blokadę powstaje PO commicie poprzedniej,
 * więc remis wymaga obu w tej samej milisekundzie — nie rozstrzygamy go
 * osobną kolumną sekwencji.
 */
export function recordConsentInTx(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    kind: ConsentKind;
    action: ConsentAction;
    source: string;
    householdId: string | null;
  },
) {
  return tx.consentEvent.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      action: input.action,
      documentVersion: LEGAL_DOCUMENT_VERSIONS[input.kind],
      source: input.source,
      householdId: input.householdId,
    },
  });
}
