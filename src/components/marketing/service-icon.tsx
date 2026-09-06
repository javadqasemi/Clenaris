'use client';

import {
  Building,
  Building2,
  HardHat,
  Home,
  PanelsTopLeft,
  Sparkles,
  Truck,
} from 'lucide-react';

/**
 * Symbol einer Dienstleistung.
 *
 * Der Name steht als Zeichenkette am Datensatz (`Service.icon`), damit der
 * Katalog ohne Codeänderung erweiterbar bleibt. Aufgelöst wird er hier —
 * einmal, für Kopfzeile, Buchungsassistent und Leistungsseiten.
 *
 * Unbekannte Namen fallen auf `Sparkles` zurück statt zu scheitern: ein
 * fehlendes Symbol darf keine Seite zerlegen.
 */
const SERVICE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Home,
  Truck,
  Building2,
  Building,
  PanelsTopLeft,
  HardHat,
  Sparkles,
};

export function ServiceIcon({ name, className }: { name: string; className?: string }) {
  const Icon = SERVICE_ICONS[name] ?? Sparkles;
  return <Icon className={className} />;
}

export function serviceIconFor(name: string) {
  return SERVICE_ICONS[name] ?? Sparkles;
}
