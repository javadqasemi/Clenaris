/**
 * Die Regeln des Bauvergleichs — welche Unterschiede zwischen zwei Bauten
 * desselben Stands erwartet sind und welche nicht (2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Wozu
 * ---------------------------------------------------------------------------
 *
 * Das Release-Artefakt behauptet: Dieser Bau ist *der* Bau dieses Commits.
 * Das stimmt nur, wenn ein zweiter Bau desselben Commits dasselbe ergibt —
 * sonst hängt das Ergebnis an etwas, das nicht im Commit steht: an der Uhrzeit,
 * am Rechner, an der Datenbank, gegen die vorgerendert wurde. Genau solche
 * Abhängigkeiten sind die Fehler, die niemand sieht, weil jeder Bau für sich
 * gut aussieht: eine Seite mit „Stand: 30.09.2026 15:29" im HTML, eine
 * Sitemap mit Beiträgen aus der Prüfdatenbank, ein Bündel mit einem Pfad des
 * CI-Rechners.
 *
 * `scripts/bau-vergleich.ts` legt zwei Bauverzeichnisse nebeneinander und
 * meldet jeden Unterschied, der nicht auf der Liste unten steht. Die Liste ist
 * bewusst kurz: Jeder Eintrag ist ein Unterschied, den Next **absichtlich**
 * bei jedem Bau neu würfelt oder der nur den Bauvorgang beschreibt, und für
 * jeden steht dabei, warum er harmlos ist. Alles andere — auch ein
 * eingebettetes Baudatum — ist ein Befund.
 *
 * ---------------------------------------------------------------------------
 *  Wie verglichen wird
 * ---------------------------------------------------------------------------
 *
 * Datei für Datei, über den relativen Pfad. Vorher wird auf beiden Seiten
 * dasselbe normalisiert: die Build-ID (im Verzeichnisnamen `static/<id>` und
 * im Inhalt) durch einen Platzhalter, die Vorschau- und Aktionsschlüssel in
 * ihren Manifesten durch einen Platzhalter. Nur was **danach** noch
 * verschieden ist, zählt als unerwartet. Verglichen wird bytegenau —
 * Dateien werden als `latin1` gelesen, damit jedes Byte genau einem Zeichen
 * entspricht: Eine UTF-8-Dekodierung machte aus zwei verschiedenen ungültigen
 * Folgen dasselbe Ersatzzeichen, und zwei verschiedene Bilder sähen gleich
 * aus.
 *
 * `<distDir>/cache` wird nicht verglichen: Er gehört nicht ins Artefakt
 * (`scripts/release/artefakt-regeln.ts`) und ist von Bau zu Bau verschieden.
 *
 * Voraussetzung für einen sinnvollen Vergleich: beide Bauten **im selben
 * Verzeichnis** und mit demselben `NEXT_DIST_DIR` erzeugt, dann umbenannt
 * (`.next` → `.next-bau-a`, neu bauen, `.next` gegen `.next-bau-a`).
 * `required-server-files.json` enthält den absoluten Projektpfad und den
 * Namen des Bauverzeichnisses; zwei Bauten in verschiedenen Verzeichnissen
 * unterschieden sich dort. Das wäre kein Fehler des Baus, sondern des
 * Versuchsaufbaus — der Vergleich meldet es trotzdem, statt Pfade zu raten.
 */
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// ===========================================================================
//  Erwartete Unterschiede
// ===========================================================================

export type ErwarteteAbweichung = 'build-id' | 'build-id-verzeichnis' | 'vorschau-schluessel' | 'aktionsschluessel' | 'spurdatei';

/**
 * Die abschliessende Liste — mit dem Grund, warum jeder Eintrag harmlos ist.
 * Ein neuer Eintrag hier braucht dieselbe Begründung; „war halt verschieden"
 * ist keine.
 */
export const ERWARTETE_ABWEICHUNGEN: Record<ErwarteteAbweichung, string> = {
  'build-id':
    'Build-ID: Next würfelt sie je Bau (kein generateBuildId); sie steht in BUILD_ID, im HTML (Pfad des Bau-Manifests) und in den Manifesten.',
  'build-id-verzeichnis': 'Verzeichnis static/<Build-ID>: derselbe Inhalt unter dem Namen der jeweiligen Build-ID.',
  'vorschau-schluessel':
    'Vorschauschlüssel (prerender-manifest.json unter preview, server/middleware-manifest.json unter env.__NEXT_PREVIEW_MODE_*): je Bau zufällig, damit ein Vorschau-Cookie nur für diesen Bau gilt.',
  aktionsschluessel:
    'Aktionsschlüssel (server/server-reference-manifest.json encryptionKey, server/middleware-manifest.json env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY): je Bau zufällig (ohne NEXT_SERVER_ACTIONS_ENCRYPTION_KEY); verschlüsselt die gebundenen Argumente von Server Actions.',
  spurdatei: 'Spurdateien (trace, *.nft.json): Zeitmessungen und Dateilisten des Bauvorgangs, von der laufenden Anwendung nie gelesen.',
};

export const PLATZHALTER = {
  buildId: '__BUILD_ID__',
  vorschau: '__VORSCHAU_SCHLUESSEL__',
  aktion: '__AKTIONSSCHLUESSEL__',
} as const;

/** Nicht verglichen: Er gehört nicht ins Artefakt und ist bei jedem Bau anders. */
export function imVergleich(pfad: string): boolean {
  return pfad !== 'cache' && !pfad.startsWith('cache/');
}

/**
 * Dateien, deren Inhalt sich als Ganzes erwartungsgemäss unterscheidet.
 *
 * `trace` ist das Zeitprotokoll des Bauvorgangs. `*.nft.json` sind die
 * Dateilisten der Node-Dateiverfolgung (`outputFileTracing`) — sie dienen
 * einem eigenständigen Bündel (`output: 'standalone'`), das diese Anwendung
 * nicht nutzt; das Artefakt enthält `node_modules` vollständig, und kein
 * Laufzeitpfad liest sie. Die Reihenfolge ihrer Einträge hängt an der
 * Parallelität des Bauvorgangs.
 */
export function ganzeDateiErwartet(pfad: string): ErwarteteAbweichung | null {
  if (pfad === 'BUILD_ID') return 'build-id';
  if (pfad === 'trace' || pfad.endsWith('.nft.json')) return 'spurdatei';
  return null;
}

// ===========================================================================
//  Normalisieren
// ===========================================================================

/** `static/<Build-ID>/…` → `static/__BUILD_ID__/…`; jeder andere Pfad bleibt, wie er ist. */
export function pfadNormalisieren(pfad: string, buildId: string): string {
  const praefix = `static/${buildId}`;
  if (pfad === praefix || pfad.startsWith(`${praefix}/`)) return `static/${PLATZHALTER.buildId}${pfad.slice(praefix.length)}`;
  return pfad;
}

function alleErsetzen(text: string, suche: string, durch: string): { text: string; anzahl: number } {
  if (!suche) return { text, anzahl: 0 };
  const teile = text.split(suche);
  return { text: teile.join(durch), anzahl: teile.length - 1 };
}

/**
 * Die je Bau gewürfelten Werte, die Next der Middleware unter `env` mitgibt
 * (`server/middleware-manifest.json`), mit der Regel, unter der sie erwartet
 * sind. Eine abschliessende Liste wie `ERWARTETE_ABWEICHUNGEN`: Ein neuer
 * Schlüssel unter `env` bleibt ein Befund, bis jemand ihn hier begründet.
 */
const MIDDLEWARE_SCHLUESSEL: readonly (readonly [string, 'vorschau-schluessel' | 'aktionsschluessel'])[] = [
  ['NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', 'aktionsschluessel'],
  ['__NEXT_PREVIEW_MODE_ID', 'vorschau-schluessel'],
  ['__NEXT_PREVIEW_MODE_SIGNING_KEY', 'vorschau-schluessel'],
  ['__NEXT_PREVIEW_MODE_ENCRYPTION_KEY', 'vorschau-schluessel'],
];

/** Ein JSON-Manifest gezielt ändern; unlesbar bleibt es unverändert und fällt im Vergleich auf. */
function jsonAendern(text: string, aendern: (wert: Record<string, unknown>) => boolean): string {
  try {
    const wert = JSON.parse(Buffer.from(text, 'latin1').toString('utf8')) as unknown;
    if (!wert || typeof wert !== 'object' || Array.isArray(wert)) return text;
    if (!aendern(wert as Record<string, unknown>)) return text;
    return Buffer.from(JSON.stringify(wert), 'utf8').toString('latin1');
  } catch {
    return text;
  }
}

/**
 * Den Inhalt einer Datei für den Vergleich herrichten.
 *
 *  • Die Build-ID wird überall ersetzt, wo sie wörtlich steht. Sie ist eine
 *    zufällige Zeichenkette von über 20 Zeichen; ein zufälliger Treffer in
 *    anderem Inhalt ist ausgeschlossen, und eine Liste der Dateien, in denen
 *    sie stehen *darf*, veraltete mit jeder Next-Fassung.
 *  • `prerender-manifest.json`: nur die drei Schlüssel unter `preview`. Der
 *    Rest (Routen, Revalidierung) wird verglichen — eine Seite, die in einem
 *    Bau statisch und im anderen dynamisch ist, ist ein Befund.
 *  • `server/server-reference-manifest.{json,js}`: nur `encryptionKey`. Die
 *    Kennungen der Aktionen werden verglichen.
 *  • `server/middleware-manifest.json`: nur die vier Schlüssel unter `env`
 *    jedes Eintrags in `middleware` und `functions`
 *    (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, `__NEXT_PREVIEW_MODE_ID`,
 *    `…_SIGNING_KEY`, `…_ENCRYPTION_KEY`). Next 15.5 gibt der Middleware dort
 *    dieselben Werte mit wie den beiden anderen Manifesten — sie läuft in
 *    einer eigenen Laufzeit und liest sie nicht aus jenen. Bis 2026-10-01
 *    fehlte diese Datei hier, und zwei Bauten desselben Commits endeten
 *    **immer** mit Ausgang 1: Das Werkzeug wäre als Tor unbrauchbar gewesen,
 *    und wer es dreimal rot sieht, schaltet es ab. `__NEXT_BUILD_ID` steht
 *    daneben und ist schon durch die Build-ID oben ersetzt; `matchers`,
 *    `files` und alles andere werden verglichen — eine Middleware, die in
 *    einem Bau andere Pfade abdeckt, ist ein Befund.
 *
 * Wo die Schlüssel stehen, ist nachgemessen, nicht angenommen: Eine Suche
 * nach den vier Werten über alle Dateien eines echten Baus (ohne `cache/`)
 * fand sie genau in diesen drei Manifesten. `server-reference-manifest.js`
 * trägt in Next 15.5 nur den Platzhalter
 * `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` und ist in zwei Bauten
 * bytegleich; die Regel dafür bleibt trotzdem, weil eine Fassung, die den
 * Schlüssel dort einsetzt, sonst jeden Vergleich rot machte, ohne dass sich
 * am Bau etwas geändert hätte.
 *
 * Nur die Manifeste werden als UTF-8-JSON geparst, weil nur dort Felder
 * gezielt ersetzt werden; alles andere bleibt `latin1` (siehe Kopf).
 */
export function inhaltNormalisieren(pfad: string, inhalt: Buffer, buildId: string): { text: string; abweichungen: ErwarteteAbweichung[] } {
  const abweichungen = new Set<ErwarteteAbweichung>();
  let text = inhalt.toString('latin1');

  const ersetzt = alleErsetzen(text, buildId, PLATZHALTER.buildId);
  text = ersetzt.text;
  if (ersetzt.anzahl > 0) abweichungen.add('build-id');

  if (pfad === 'prerender-manifest.json') {
    text = jsonAendern(text, (manifest) => {
      const vorschau = manifest.preview;
      if (!vorschau || typeof vorschau !== 'object') return false;
      let geaendert = false;
      for (const schluessel of ['previewModeId', 'previewModeSigningKey', 'previewModeEncryptionKey']) {
        if (schluessel in vorschau) {
          (vorschau as Record<string, unknown>)[schluessel] = PLATZHALTER.vorschau;
          geaendert = true;
        }
      }
      if (geaendert) abweichungen.add('vorschau-schluessel');
      return geaendert;
    });
  }

  if (pfad === 'server/server-reference-manifest.json') {
    text = jsonAendern(text, (manifest) => {
      if (typeof manifest.encryptionKey !== 'string') return false;
      manifest.encryptionKey = PLATZHALTER.aktion;
      abweichungen.add('aktionsschluessel');
      return true;
    });
  }

  if (pfad === 'server/middleware-manifest.json') {
    text = jsonAendern(text, (manifest) => {
      let geaendert = false;
      for (const gruppe of ['middleware', 'functions']) {
        const eintraege = manifest[gruppe];
        if (!eintraege || typeof eintraege !== 'object') continue;
        for (const eintrag of Object.values(eintraege as Record<string, unknown>)) {
          const umgebung = eintrag && typeof eintrag === 'object' ? (eintrag as Record<string, unknown>).env : undefined;
          if (!umgebung || typeof umgebung !== 'object') continue;
          const werte = umgebung as Record<string, unknown>;
          for (const [schluessel, art] of MIDDLEWARE_SCHLUESSEL) {
            if (typeof werte[schluessel] !== 'string') continue;
            werte[schluessel] = art === 'aktionsschluessel' ? PLATZHALTER.aktion : PLATZHALTER.vorschau;
            abweichungen.add(art);
            geaendert = true;
          }
        }
      }
      return geaendert;
    });
  }

  if (pfad === 'server/server-reference-manifest.js') {
    // `self.__RSC_SERVER_MANIFEST="{\"node\":…,\"encryptionKey\":\"…\"}"` — JSON in einer JS-Zeichenkette.
    const vorher = text;
    text = text.replace(/(\\?"encryptionKey\\?"\s*:\s*\\?")(?:[^"\\]|\\(?!"))*(\\?")/g, `$1${PLATZHALTER.aktion}$2`);
    if (text !== vorher) abweichungen.add('aktionsschluessel');
  }

  return { text, abweichungen: [...abweichungen].sort() };
}

// ===========================================================================
//  Vergleichen
// ===========================================================================

/** Ein Bauverzeichnis als Quelle — auf der Platte (`verzeichnisQuelle`) oder im Speicher (Prüfung). */
export interface Baumquelle {
  buildId: string;
  /** Alle Dateien relativ zum Bauverzeichnis, mit `/`. */
  pfade: readonly string[];
  lesen(pfad: string): Buffer;
}

export type UnerwarteteArt = 'nur-in-a' | 'nur-in-b' | 'inhalt';

export interface Unerwartet {
  /** Pfad nach Normalisierung (Build-ID durch Platzhalter ersetzt). */
  pfad: string;
  art: UnerwarteteArt;
  /** Bei `inhalt`: Stelle des ersten Unterschieds und je ein kurzer Auszug. */
  stelle?: number;
  auszugA?: string;
  auszugB?: string;
}

export interface Vergleichsbefund {
  buildIdA: string;
  buildIdB: string;
  /** Dateien ohne jeden Unterschied. */
  gleich: number;
  /** Dateien, die sich nur erwartungsgemäss unterscheiden. */
  erwartet: { pfad: string; abweichungen: ErwarteteAbweichung[] }[];
  unerwartet: Unerwartet[];
}

/**
 * Ein Auszug um die erste abweichende Stelle — damit ein Befund wie ein
 * eingebettetes Datum ohne Werkzeug zu erkennen ist.
 *
 * Lange Folgen aus Hex- oder Base64-Zeichen werden geschwärzt: Der Auszug
 * landet im CI-Protokoll und im Bericht, und sollte Next einmal einen neuen
 * zufälligen Schlüssel an einer Stelle ablegen, die diese Liste nicht kennt,
 * stünde er sonst dort — ausgerechnet der Schlüssel des Baus, der vielleicht
 * ausgeliefert wird. Der Vorschauschlüssel etwa öffnet den Entwurfsmodus der
 * Website (`/admin/inhalte`).
 */
export function auszug(text: string, stelle: number, rand = 40): string {
  const roh = text.slice(Math.max(0, stelle - rand), stelle + rand);
  return Buffer.from(roh, 'latin1')
    .toString('utf8')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z0-9+/=_-]{24,}/g, '[…]');
}

function ersteAbweichung(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  return n;
}

/**
 * Zwei Bäume vergleichen. Liest jede Datei höchstens einmal je Seite und hält
 * nie einen ganzen Baum im Speicher — ein `.next` mit Servern und Bündeln hat
 * mehrere hundert Megabyte.
 */
export function baeumeVergleichen(a: Baumquelle, b: Baumquelle): Vergleichsbefund {
  const karte = (q: Baumquelle) => {
    const m = new Map<string, string>();
    for (const pfad of q.pfade) if (imVergleich(pfad)) m.set(pfadNormalisieren(pfad, q.buildId), pfad);
    return m;
  };
  const karteA = karte(a);
  const karteB = karte(b);
  const alle = [...new Set([...karteA.keys(), ...karteB.keys()])].sort();

  const befund: Vergleichsbefund = { buildIdA: a.buildId, buildIdB: b.buildId, gleich: 0, erwartet: [], unerwartet: [] };
  for (const pfad of alle) {
    const pfadA = karteA.get(pfad);
    const pfadB = karteB.get(pfad);
    if (pfadA === undefined) {
      befund.unerwartet.push({ pfad, art: 'nur-in-b' });
      continue;
    }
    if (pfadB === undefined) {
      befund.unerwartet.push({ pfad, art: 'nur-in-a' });
      continue;
    }
    const verzeichnis: ErwarteteAbweichung[] = pfadA !== pfadB ? ['build-id-verzeichnis'] : [];
    const rohA = a.lesen(pfadA);
    const rohB = b.lesen(pfadB);

    if (rohA.equals(rohB)) {
      if (verzeichnis.length > 0) befund.erwartet.push({ pfad, abweichungen: verzeichnis });
      else befund.gleich++;
      continue;
    }
    const ganz = ganzeDateiErwartet(pfad);
    if (ganz) {
      befund.erwartet.push({ pfad, abweichungen: [...new Set([ganz, ...verzeichnis])].sort() });
      continue;
    }
    const normA = inhaltNormalisieren(pfad, rohA, a.buildId);
    const normB = inhaltNormalisieren(pfad, rohB, b.buildId);
    if (normA.text === normB.text) {
      befund.erwartet.push({ pfad, abweichungen: [...new Set([...normA.abweichungen, ...normB.abweichungen, ...verzeichnis])].sort() });
      continue;
    }
    const stelle = ersteAbweichung(normA.text, normB.text);
    befund.unerwartet.push({ pfad, art: 'inhalt', stelle, auszugA: auszug(normA.text, stelle), auszugB: auszug(normB.text, stelle) });
  }
  return befund;
}

// ===========================================================================
//  Bauverzeichnis auf der Platte
// ===========================================================================

/**
 * Ein Bauverzeichnis als Quelle: alle Dateien (Verweise mit ihrem Ziel als
 * Inhalt), ohne `cache/`. Verlangt `BUILD_ID` — ein Verzeichnis ohne ist kein
 * abgeschlossener Bau, und ein Vergleich damit bewiese nichts.
 */
export function verzeichnisQuelle(verzeichnis: string): Baumquelle {
  let buildId: string;
  try {
    buildId = readFileSync(join(verzeichnis, 'BUILD_ID'), 'utf8').trim();
  } catch {
    throw new Error(`${verzeichnis} enthält keine BUILD_ID — kein abgeschlossener Bau.`);
  }
  if (!buildId) throw new Error(`${verzeichnis}/BUILD_ID ist leer.`);

  const pfade: string[] = [];
  const ablaufen = (relativ: string) => {
    for (const kind of readdirSync(join(verzeichnis, relativ), { withFileTypes: true })) {
      const pfad = relativ ? `${relativ}/${kind.name}` : kind.name;
      if (!imVergleich(pfad)) continue;
      if (kind.isDirectory()) ablaufen(pfad);
      else pfade.push(pfad);
    }
  };
  ablaufen('');
  return {
    buildId,
    pfade,
    lesen: (pfad) => {
      const voll = join(verzeichnis, pfad);
      return lstatSync(voll).isSymbolicLink() ? Buffer.from(`-> ${readlinkSync(voll)}`, 'utf8') : readFileSync(voll);
    },
  };
}

/** Der Bericht für `--bericht`: maschinenlesbar, mit derselben Aussage wie der Ausgangscode. */
export function berichtBauen(o: { a: string; b: string; befund: Vergleichsbefund; erstelltUtc: string }) {
  const jeRegel: Partial<Record<ErwarteteAbweichung, number>> = {};
  for (const e of o.befund.erwartet) for (const art of e.abweichungen) jeRegel[art] = (jeRegel[art] ?? 0) + 1;
  return {
    format: 1,
    ergebnis: o.befund.unerwartet.length === 0 ? ('nur-erwartete-unterschiede' as const) : ('unerwartete-unterschiede' as const),
    a: o.a,
    b: o.b,
    buildIdA: o.befund.buildIdA,
    buildIdB: o.befund.buildIdB,
    erstelltUtc: o.erstelltUtc,
    gleich: o.befund.gleich,
    erwartetJeRegel: jeRegel,
    regeln: ERWARTETE_ABWEICHUNGEN,
    erwartet: o.befund.erwartet,
    unerwartet: o.befund.unerwartet,
  };
}
