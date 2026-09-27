-- Podpowiedź przy kciuku w dół (powody + zdanie), migawka odpowiedzi wysłana
-- razem z podpowiedzią i rodzaj odpowiedzi — pod dział „Oceny” w panelu.
--
-- Addytywnie: nowe kolumny z wartościami domyślnymi, istniejące oceny bez zmian.
-- Rollback: ALTER TABLE "AgentMessageFeedback" DROP COLUMN "tags", DROP COLUMN "comment",
--   DROP COLUMN "messageText", DROP COLUMN "messageKind";

-- AlterTable
ALTER TABLE "AgentMessageFeedback" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "messageKind" TEXT NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "messageText" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
