'use client';

import { AreaError } from '@/components/app/area-error';

/**
 * Fehlergrenze dieses Bereichs.
 *
 * Liegt bewusst *unter* dem Layout: Navigation, Benachrichtigungen und
 * Kontomenü bleiben stehen, nur der Inhaltsbereich zeigt den Fehler.
 */
export default function AreaErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <AreaError error={error} reset={reset} homeHref="/portal" homeLabel="Zu meinen Einsätzen" />;
}