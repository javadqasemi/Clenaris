'use client';

import * as React from 'react';
import { useTheme } from 'next-themes';

/**
 * Farbwerte für Diagramme.
 *
 * Architekturentscheid: Diagrammfarben sind *nicht* die CSS-Variablen des
 * Interfaces. Recharts braucht konkrete Hex-Werte (SVG-Attribute, keine
 * berechneten Styles), und Diagrammfarben haben eine andere Aufgabe als
 * Bedienelemente: sie müssen nebeneinander unterscheidbar bleiben, auch bei
 * Farbfehlsichtigkeit.
 *
 * Die Werte wurden gegen die sechs Prüfungen der Palettenvalidierung geprüft
 * (Helligkeitsband, Sättigungsuntergrenze, CVD-Abstand für Deutan/Protan/Tritan,
 * Normalsicht-Abstand, Kontrast zur Fläche) — je einmal für hell und dunkel.
 *
 * Kategorial sind bewusst nur drei Reihen definiert: Umsatz, Kosten, Gewinn.
 * Ranglisten (Umsatz je Leistung, Auslastung je Person) nutzen eine
 * einfarbige Abstufung, weil dort die Achsenbeschriftung die Identität trägt
 * und die Farbe nur die Grösse — eine sechste Kategorialfarbe wäre für
 * Rot-Grün-Sehschwäche nicht mehr sicher trennbar.
 */

export interface ChartTheme {
  /** Kategoriale Reihen in fester Reihenfolge — nie rotierend vergeben. */
  categorical: [string, string, string];
  /** Einfarbige Abstufung, hell → dunkel für Ranglisten. */
  sequential: string[];
  /** Zweipolig: positiv / negativ, mit neutraler Mitte. */
  diverging: { positive: string; negative: string; neutral: string };
  grid: string;
  axis: string;
  label: string;
  surface: string;
  border: string;
  reference: string;
}

const LIGHT: ChartTheme = {
  categorical: ['#00929E', '#C0392B', '#6D4BD6'],
  sequential: ['#0A6E77', '#0E8A94', '#22A3AD', '#5CBFC7', '#95D8DD', '#C8ECEF'],
  diverging: { positive: '#00929E', negative: '#C0392B', neutral: '#94A3B8' },
  grid: 'rgba(15, 28, 31, 0.08)',
  axis: 'rgba(15, 28, 31, 0.18)',
  label: '#5A6B6E',
  surface: '#FFFFFF',
  border: '#E2E9E9',
  reference: 'rgba(15, 28, 31, 0.35)',
};

const DARK: ChartTheme = {
  categorical: ['#1FA0AC', '#D9584A', '#8A72E4'],
  sequential: ['#2FB3BE', '#28A0AB', '#218D97', '#1B7A84', '#146770', '#0E545C'],
  diverging: { positive: '#1FA0AC', negative: '#D9584A', neutral: '#64748B' },
  grid: 'rgba(230, 239, 239, 0.08)',
  axis: 'rgba(230, 239, 239, 0.18)',
  label: '#93A8AB',
  surface: '#0D1E22',
  border: '#1D383D',
  reference: 'rgba(230, 239, 239, 0.35)',
};

export function useChartTheme(): { theme: ChartTheme; isDark: boolean; mounted: boolean } {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => setMounted(true), []);

  const isDark = mounted && resolvedTheme === 'dark';
  return { theme: isDark ? DARK : LIGHT, isDark, mounted };
}

/** Abstufung auf n Werte verteilen — dunkelster Ton für den grössten Wert. */
export function rampFor(theme: ChartTheme, count: number): string[] {
  if (count <= 0) return [];
  if (count === 1) return [theme.sequential[0]];

  const steps = theme.sequential;
  return Array.from({ length: count }, (_, index) => {
    const position = (index / (count - 1)) * (steps.length - 1);
    return steps[Math.round(position)];
  });
}
