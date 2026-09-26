/**
 * Musterprüfung für `npm run security:check` (Sicherheitsautomation,
 * 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Was ein Treffer ist — und was nicht
 * ---------------------------------------------------------------------------
 *
 * Ein Treffer ist ein **Anlass zur Durchsicht**, kein Befund über eine Lücke.
 * `$queryRawUnsafe` mit einem festen Text ist sicher; derselbe Aufruf mit
 * einem Wert aus der Anfrage ist eine SQL-Injection. Das unterscheidet kein
 * regulärer Ausdruck. Deshalb:
 *
 *  • Jede Regel sagt, **welche Frage** sie der Durchsicht stellt.
 *  • Eine Stelle, die durchgesehen und in Ordnung ist, kommt mit Begründung in
 *    `security/unterdrueckungen.json`. Eine Unterdrückung ohne Begründung ist
 *    selbst ein Befund.
 *  • Eine Unterdrückung gilt für eine Datei und eine Regel, nie global. Kommt
 *    in derselben Datei eine *zweite* Stelle dazu, wird sie trotzdem
 *    unterdrückt — deshalb nennt die Unterdrückung die erwartete Anzahl, und
 *    mehr Treffer als erwartet heben sie auf.
 *
 * Was diese Prüfung **nicht** findet: fehlende `organizationId` in einer neuen
 * Abfrage, eine falsche Rechteprüfung, einen Logikfehler, eine Lücke in einer
 * Abhängigkeit. Dafür gibt es die Prüfreihe, die Durchsicht nach
 * `docs/SECURITY_STANDARD.md` und `npm audit`. Eine Semgrep- oder
 * CodeQL-Prüfung wäre gründlicher; sie ist in `docs/SECURITY_AUTOMATION.md`
 * beschrieben, aber nicht eingerichtet (keine stille Installation).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type Schwere = 'blockierend' | 'warnung' | 'hinweis';

export interface Regel {
  id: string;
  schwere: Schwere;
  /** Die Frage an die Durchsicht. */
  frage: string;
  /** Relativer Pfad (mit `/`) → wird die Datei geprüft? */
  gilt: (pfad: string) => boolean;
  /** Treffer je Zeile — oder für ganze Dateien `datei`. */
  muster?: RegExp;
  datei?: (inhalt: string, pfad: string) => string | null;
  /** Standard C… aus `docs/SECURITY_STANDARD.md`. */
  standard: string;
}

export interface Treffer {
  regel: string;
  schwere: Schwere;
  datei: string;
  zeile: number;
  auszug: string;
  frage: string;
  standard: string;
  unterdrueckt?: string;
}

export interface Unterdrueckung {
  regel: string;
  datei: string;
  /** Wie viele Treffer diese Begründung abdeckt. Mehr heben sie auf. */
  anzahl: number;
  begruendung: string;
}

const anwendung = (p: string) => p.startsWith('src/');
const serverseitig = (p: string) => p.startsWith('src/server/') || p.startsWith('src/lib/') || p.startsWith('src/app/api/');
const oberflaeche = (p: string) => p.startsWith('src/') && p.endsWith('.tsx');

export const REGELN: Regel[] = [
  {
    id: 'sql-unsafe',
    schwere: 'blockierend',
    standard: 'C5',
    frage: 'Ist der SQL-Text vollständig konstant? Jeder Wert muss als Parameter gehen (`$queryRaw`/`Prisma.sql`).',
    gilt: (p) => anwendung(p) || p.startsWith('scripts/'),
    muster: /\$(queryRaw|executeRaw)Unsafe\s*[(<]/,
  },
  {
    id: 'prozess',
    schwere: 'blockierend',
    standard: 'C5',
    frage: 'Anwendungscode startet keine Prozesse. Ist das wirklich nie von einer Anfrage aus erreichbar?',
    gilt: anwendung,
    muster: /(from\s+['"](node:)?child_process['"]|require\(\s*['"](node:)?child_process['"]\s*\))/,
  },
  {
    id: 'eval',
    schwere: 'blockierend',
    standard: 'C5',
    frage: 'Code aus Text zu erzeugen ist in der Anwendung nicht vorgesehen.',
    gilt: anwendung,
    muster: /(^|[^.\w])eval\s*\(|new\s+Function\s*\(/,
  },
  {
    id: 'html-roh',
    schwere: 'warnung',
    standard: 'C6',
    frage: 'Ist der eingesetzte Text vollständig maskiert oder vollständig eigener, konstanter Inhalt?',
    gilt: oberflaeche,
    muster: /dangerouslySetInnerHTML/,
  },
  {
    id: 'dom-html',
    schwere: 'warnung',
    standard: 'C6',
    frage: 'Wird hier fremder Text als HTML in das DOM geschrieben?',
    gilt: anwendung,
    muster: /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/,
  },
  {
    id: 'oeffentliches-geheimnis',
    schwere: 'blockierend',
    standard: 'C10',
    frage: '`NEXT_PUBLIC_` landet im Browser. Ein Geheimnis darf so nicht heissen.',
    gilt: (p) => anwendung(p) || p === '.env.example' || p === 'next.config.ts',
    muster: /NEXT_PUBLIC_[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY)\b/,
  },
  {
    id: 'tls-aus',
    schwere: 'blockierend',
    standard: 'C8',
    frage: 'Zertifikatsprüfung abgeschaltet?',
    gilt: (p) => anwendung(p) || p.startsWith('scripts/'),
    muster: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/,
  },
  {
    id: 'speicher-token',
    schwere: 'blockierend',
    standard: 'C1',
    frage: 'Tokens gehören in HttpOnly-Cookies, nicht in den Browserspeicher.',
    gilt: anwendung,
    muster: /(localStorage|sessionStorage)\.setItem\([^)]*(token|secret|passwort|password)/i,
  },
  {
    id: 'zufall',
    schwere: 'warnung',
    standard: 'C13',
    frage: '`Math.random` ist nicht kryptografisch. Entsteht hier ein Token, Code oder Geheimnis?',
    gilt: serverseitig,
    muster: /Math\.random\s*\(/,
  },
  {
    id: 'cors-alles',
    schwere: 'warnung',
    standard: 'C7',
    frage: 'CORS für jede Herkunft — wirklich öffentlich und ohne Cookies?',
    gilt: anwendung,
    muster: /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]/,
  },
  {
    id: 'klartext-http',
    schwere: 'warnung',
    standard: 'C8',
    frage: 'Ausgehende Verbindung ohne TLS?',
    gilt: serverseitig,
    muster: /fetch\(\s*['"`]http:\/\/(?!localhost|127\.0\.0\.1)/,
  },
  {
    id: 'protokoll-geheimnis',
    schwere: 'warnung',
    standard: 'C10',
    frage: 'Landet ein Geheimnis in der Konsole oder im Log?',
    gilt: anwendung,
    muster: /console\.(log|info|debug|warn)\([^)]*\b(password|passwort|token|secret|apiKey)\b/i,
  },
  {
    id: 'route-ohne-factory',
    schwere: 'blockierend',
    standard: 'C2',
    frage: 'Jeder Endpunkt entsteht über `defineRoute`/`definePublicRoute`/`defineCronRoute` — sonst fehlt Schutzdeklaration, Origin-Prüfung und Rate-Limit.',
    gilt: (p) => p.startsWith('src/app/api/') && p.endsWith('/route.ts'),
    datei: (inhalt) => {
      const exporte = [...inhalt.matchAll(/export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b([^\n]*)/g)];
      for (const e of exporte) {
        const zeile = e[2] ?? '';
        if (/function/.test(e[0]) || !/define(Public|Cron)?Route\s*\(/.test(zeile)) return `${e[1]} ohne Routenfactory`;
      }
      return null;
    },
  },
  {
    id: 'rate-limit-fehlt',
    schwere: 'warnung',
    standard: 'C9',
    frage: 'Jeder Endpunkt braucht ein Kontingent — im Factory (`rateLimit`) oder von Hand (`enforceRateLimit`). Wo sonst wird begrenzt?',
    gilt: (p) => p.startsWith('src/app/api/') && p.endsWith('/route.ts'),
    datei: (inhalt) => {
      // Cron-Endpunkte hängen an einem Maschinentoken mit zeitkonstantem Vergleich.
      if (/defineCronRoute\s*\(/.test(inhalt)) return null;
      return /rateLimit\s*:|enforceRateLimit\s*\(/.test(inhalt) ? null : 'kein rateLimit und kein enforceRateLimit in der Routendatei';
    },
  },
  {
    id: 'weiterleitung-frei',
    schwere: 'warnung',
    standard: 'C6',
    frage: 'Weiterleitung auf einen Wert aus der Anfrage — nur eigene Pfade (`/…`, nicht `//…`)?',
    gilt: anwendung,
    muster: /(redirect|NextResponse\.redirect)\(\s*(searchParams|query|params|body)\./,
  },
];

const AUSGESCHLOSSEN = ['node_modules', '.next', '.next-sprint', '.git', 'coverage', 'test-results', 'playwright-report', 'security-reports'];

function dateien(wurzel: string, verzeichnis: string, aus: string[]): string[] {
  const ergebnis: string[] = [];
  for (const name of readdirSync(join(wurzel, verzeichnis))) {
    if (AUSGESCHLOSSEN.includes(name) || name.startsWith('.next')) continue;
    const pfad = verzeichnis ? `${verzeichnis}/${name}` : name;
    const s = statSync(join(wurzel, pfad));
    if (s.isDirectory()) ergebnis.push(...dateien(wurzel, pfad, aus));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) || aus.includes(pfad)) ergebnis.push(pfad);
  }
  return ergebnis;
}

export function musterPruefen(wurzel: string, unterdrueckungen: Unterdrueckung[]): { treffer: Treffer[]; fehler: string[] } {
  const fehler: string[] = [];
  for (const u of unterdrueckungen) {
    if (!u.begruendung || u.begruendung.trim().length < 20) fehler.push(`Unterdrückung ohne ausreichende Begründung: ${u.regel} in ${u.datei}`);
    if (!REGELN.some((r) => r.id === u.regel)) fehler.push(`Unterdrückung für unbekannte Regel: ${u.regel}`);
  }

  // Die Prüfung selbst enthält jedes Muster als Text — sie prüft sich nicht.
  const kandidaten = [...dateien(wurzel, 'src', []), ...dateien(wurzel, 'scripts', []), 'next.config.ts', '.env.example']
    .map((p) => p.split(sep).join('/'))
    .filter((p) => !p.startsWith('scripts/security/') && p !== 'scripts/security-check.ts');
  const treffer: Treffer[] = [];
  for (const pfad of kandidaten) {
    let inhalt: string;
    try {
      inhalt = readFileSync(join(wurzel, pfad), 'utf8');
    } catch {
      continue;
    }
    for (const regel of REGELN) {
      if (!regel.gilt(pfad)) continue;
      if (regel.datei) {
        const befund = regel.datei(inhalt, pfad);
        if (befund) treffer.push({ regel: regel.id, schwere: regel.schwere, datei: pfad, zeile: 1, auszug: befund, frage: regel.frage, standard: regel.standard });
        continue;
      }
      const zeilen = inhalt.split(/\r?\n/);
      zeilen.forEach((z, i) => {
        // Kommentarzeilen erklären oft genau das Muster, das sie verbieten.
        const t = z.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        if (regel.muster!.test(z)) {
          treffer.push({ regel: regel.id, schwere: regel.schwere, datei: pfad, zeile: i + 1, auszug: t.slice(0, 160), frage: regel.frage, standard: regel.standard });
        }
      });
    }
  }

  // Unterdrückungen anwenden — je Datei und Regel höchstens `anzahl` Treffer.
  for (const u of unterdrueckungen) {
    const passend = treffer.filter((t) => t.regel === u.regel && t.datei === u.datei);
    if (passend.length === 0) {
      fehler.push(`Veraltete Unterdrückung (kein Treffer mehr): ${u.regel} in ${u.datei} — bitte entfernen.`);
      continue;
    }
    if (passend.length > u.anzahl) {
      // Mehr Treffer als durchgesehen: keiner wird unterdrückt, die Datei
      // muss neu durchgesehen werden.
      continue;
    }
    for (const t of passend) t.unterdrueckt = u.begruendung;
  }
  return { treffer, fehler };
}

export function relativ(wurzel: string, pfad: string): string {
  return relative(wurzel, pfad).split(sep).join('/');
}
