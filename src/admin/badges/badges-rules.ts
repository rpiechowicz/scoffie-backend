import {
  deployInProgress,
  type KnownService,
} from '../integrations/deploy-tracker.service';

/** Uruchomienie crona z wynikiem: `EXITED` — zakończone, `CRASHED` — nieudane. */
const RUN_OK = 'EXITED';
const RUN_FAILED = 'CRASHED';

/**
 * Czy usługa „padła” — ta sama reguła co `broken()` w panelu
 * (scoffie-dashboard, features/system/railway.tsx): przy cronie z historią
 * liczy się ostatnie uruchomienie z wynikiem (plus nieudana budowa), bez
 * historii — ostatnie wdrożenie `FAILED` albo `CRASHED`.
 */
export function serviceDown(s: KnownService): boolean {
  const deploy = s.deploys[0]?.status ?? '';
  if (s.cron) {
    const last = s.runs.find(
      (r) => r.status === RUN_OK || r.status === RUN_FAILED,
    );
    if (last) return last.status === RUN_FAILED || deploy === 'FAILED';
  }
  return deploy === 'FAILED' || deploy === 'CRASHED';
}

/** Licznik „System”: ile usług padło i czy któraś się właśnie wdraża. */
export function systemBadge(
  services: KnownService[] | null,
): { down: number; deploying: boolean } | null {
  if (!services) return null;
  return {
    down: services.filter(serviceDown).length,
    deploying: services.some((s) => deployInProgress(s.deploys[0]?.status)),
  };
}
