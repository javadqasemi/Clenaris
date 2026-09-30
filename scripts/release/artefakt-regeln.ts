/**
 * Die Regeln des Release-Artefakts — was hineingehört, was draussen bleibt,
 * wie es gepackt, geprüft und beschrieben wird (2026-09-30).
 *
 * ---------------------------------------------------------------------------
 *  Warum diese Datei neben `scripts/release-artefakt.ts` steht
 * ---------------------------------------------------------------------------
 *
 * Bis 2026-09-29 stand alles im Packskript selbst, zwischen `git`, `tar` und
 * `npm`. Prüfen liess es sich nur, indem man baute und packte — also nie: Ein
 * Bau dauert Minuten, braucht eine Datenbank und hinterlässt ein Archiv von
 * mehreren hundert Megabyte. So blieben drei Fehler unbemerkt, die jede
 * Prüfung auf Regelebene sofort gefunden hätte:
 *
 *  • `tar --exclude cache` ist in GNU tar **unverankert** und traf damit jedes
 *    Verzeichnis namens `cache` — auch eines in einem Paket unter
 *    `node_modules`. Das Artefakt war nicht mehr der geprüfte Baum.
 *  • `*.tsbuildinfo` und `.env*` wirkten ebenso überall und entfernten Dateien
 *    aus Paketen (`@supabase/*` liefert `tsconfig.tsbuildinfo` mit).
 *  • Die Sauberkeitsprüfung lief mit `--untracked-files=no`: Eine neue, nie
 *    eingecheckte Datei unter `src/` reiste ins Artefakt, das Manifest nannte
 *    trotzdem „sauber" und einen Commit, der sie nicht enthält.
 *
 * Hier stehen deshalb die Entscheidungen als Funktionen, die ohne Bau und ohne
 * Datenbank aufrufbar sind (`tests/api/release-artefakt.test.ts`). Das
 * Packskript ruft sie nur noch auf und führt aus, was sie ergeben. Die Datei
 * hat keine Nebenwirkung beim Import; lesende Dateizugriffe (Baum ablaufen,
 * Bau nach Demodaten durchsuchen) stehen hier, weil sie Regeln *anwenden* —
 * geschrieben und gestartet wird ausschliesslich im Packskript.
 *
 * Der Vertrag des Manifests selbst steht in `src/lib/release/manifest.ts` und
 * wird hier nicht wiederholt, sondern geparst: Was diese Datei baut, muss dort
 * gültig sein, sonst schreibt das Packskript nichts.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';

import { DEMO_KENNZEICHEN, type Demokennzeichen } from '../../prisma/demo-kennzeichen';
import {
  artefaktBeilageSchema,
  artefaktManifestSchema,
  auslieferbarNach,
  ciHerkunftSchema,
  COMMIT_MUSTER,
  MANIFEST_FORMAT,
  MIGRATION_MUSTER,
  type ArtefaktBeilage,
  type ArtefaktManifest,
  type CiHerkunft,
} from '../../src/lib/release/manifest';

// ===========================================================================
//  Inhalt
// ===========================================================================

/**
 * Was ins Artefakt gehört. Bewusst eine Liste von Einschlüssen statt
 * Ausschlüssen: Was neu im Repository auftaucht, landet nicht zufällig in der
 * Produktion. `src` und `tsconfig.json` sind dabei, weil Betriebsskripte
 * (`backfill-kpi.ts`, `db-backup.ts`) über `tsx` die Dienste importieren.
 *
 * `prisma.config.ts` fehlte bis 2026-09-30. Seit Prisma 7 (2026-09-29) steht
 * die Verbindungsadresse der Kommandozeile **nur** dort — `schema.prisma` hat
 * keine `url` mehr, und die Kommandozeile lädt `.env` nicht selbst. Die
 * Aktivierung ruft im entpackten Release `npx prisma migrate status` und
 * `migrate deploy`; ohne die Datei hätte Prisma dort keine Datenbank gekannt,
 * und die erste Auslieferung mit offener Migration wäre an der Migration
 * gescheitert statt an einer Prüfung davor.
 */
export const INHALT = [
  'package.json',
  'package-lock.json',
  'next.config.ts',
  'prisma.config.ts',
  'ecosystem.config.js',
  'tsconfig.json',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'public',
  'prisma',
  'scripts',
  'src',
  // Das Aktivierungsskript reist mit: Das nächste Release wird mit dem
  // Skript des laufenden aktiviert, nicht mit einem Stand aus Git.
  'deploy',
  // Die durchgesehene Einstufung der Migrationen (Notfallauftrag 2026-09-27):
  // Die Produktionsvorprüfung entscheidet damit auf dem Server, ob offene
  // Migrationen ohne Wartungsfenster zusammen mit dem Umschalten laufen
  // dürfen. Ohne die Datei gälte jede offene Migration als BRECHEND.
  'security',
] as const;

/** Name des Manifests im Archiv — `deploy/v2/release-aktivieren.sh` liest es mit `tar -xzOf … RELEASE.json`. */
export const MANIFEST_DATEI = 'RELEASE.json';

/**
 * Die obersten Einträge des Archivs in fester Reihenfolge: Inhalt, Bau,
 * Module. Das Manifest kommt beim Packen als letzter Eintrag dazu.
 */
export function packliste(distDir: string, mitModulen: boolean): string[] {
  return [...INHALT, distDir, ...(mitModulen ? ['node_modules'] : [])];
}

// ===========================================================================
//  Ausschlüsse — verankert
// ===========================================================================

export type Ausschlussgrund = 'bau-zwischenspeicher' | 'umgebungsdatei' | 'typescript-zwischenstand';

export const AUSSCHLUSSGRUND_TEXT: Record<Ausschlussgrund, string> = {
  'bau-zwischenspeicher': 'Zwischenspeicher des Baus (gehört zur Bau-Maschine, nicht zum Release)',
  umgebungsdatei: 'Umgebungsdatei (Geheimnisse gehören auf den Server, nie in ein Archiv in der CI)',
  'typescript-zwischenstand': 'Zwischenstand des TypeScript-Übersetzers',
};

const UMGEBUNGSDATEI = /^\.env(\..*)?$/;

/**
 * Ob ein Pfad beim Packen draussen bleibt, und warum.
 *
 * **Verankert, nicht nach Namen.** Jede Regel nennt einen Ort, kein Muster,
 * das überall greift:
 *
 *  • `<distDir>/cache` — genau dieser eine Ordner. Ein Paket, das ein
 *    Verzeichnis `cache` mitbringt (`node_modules/<paket>/cache`), bleibt
 *    vollständig; es wegzulassen hiesse, einen anderen Baum auszuliefern, als
 *    die Prüfreihen gesehen haben.
 *  • `.env`, `.env.*` und `*.tsbuildinfo` — nur **direkt** in einem der
 *    obersten Einträge (`prisma/.env`, `scripts/.env.local`,
 *    `.next/.env`). Dort legt sie ein Mensch oder ein Werkzeug ab; tiefer in
 *    `src/` oder in einem Paket ist es Inhalt. Eine Umgebungsdatei tiefer
 *    ausserhalb von `node_modules` wird trotzdem nicht still mitgenommen:
 *    Die Gegenprobe über die Liste des fertigen Archivs
 *    (`umgebungsdateienImArchiv`) verweigert dann das Artefakt — laut, statt
 *    zu raten, ob es ein Geheimnis ist.
 *
 * `eintrag` ist der oberste Eintrag, unter dem `pfad` liegt (aus `packliste`),
 * `pfad` der Pfad relativ zur Wurzel des Repositories mit `/`.
 */
export function ausschlussGrund(o: { eintrag: string; pfad: string; distDir: string }): Ausschlussgrund | null {
  const { eintrag, pfad, distDir } = o;
  const zwischenspeicher = `${distDir}/cache`;
  if (pfad === zwischenspeicher || pfad.startsWith(`${zwischenspeicher}/`)) return 'bau-zwischenspeicher';

  // Nur die oberste Ebene unter einem Eintrag — `rest` ohne weiteren `/`.
  if (!pfad.startsWith(`${eintrag}/`)) return null;
  const rest = pfad.slice(eintrag.length + 1);
  if (rest.includes('/')) return null;
  if (UMGEBUNGSDATEI.test(rest)) return 'umgebungsdatei';
  if (rest.endsWith('.tsbuildinfo')) return 'typescript-zwischenstand';
  return null;
}

// ===========================================================================
//  Den Baum ablaufen
// ===========================================================================

/**
 * Steuerzeichen im Namen: Die Liste des fertigen Archivs (`tar -tzf`) ist
 * zeilenweise; ein Zeilenumbruch im Dateinamen machte aus einem Eintrag zwei,
 * und der Vollständigkeitsabgleich vergliche etwas anderes, als im Archiv
 * liegt. Im Repository und in `node_modules` kommt das nicht vor — ein
 * solcher Name ist ein Unfall oder ein Angriff, und beides soll anhalten.
 */
const STEUERZEICHEN = /[\u0000-\u001f\u007f]/;

export interface Baumaufnahme {
  /** Alle Einträge in Packreihenfolge, Verzeichnisse ohne abschliessenden `/`. */
  eintraege: string[];
  /** Was die Regeln draussen liessen — für die Ausgabe, nicht für den Abgleich. */
  ausgeschlossen: { pfad: string; grund: Ausschlussgrund }[];
}

/**
 * Die Einträge, die ins Archiv gehören: die obersten Einträge der Packliste,
 * rekursiv, ohne die Ausschlüsse. Diese Liste bekommt `tar` wörtlich
 * (`-T`), und dieselbe Liste muss danach im Archiv stehen.
 *
 * **Warum `tar` nicht selbst sucht.** Mit `--exclude` hinge die Bedeutung der
 * Ausschlüsse an der tar-Fassung: GNU tar verankert erst mit `--anchored` und
 * lässt `*` trotzdem über `/` greifen, bsdtar hat eigene Regeln. Dieselbe
 * Zeile hätte unter Linux (CI) und Windows (örtliche Probe) Verschiedenes
 * bedeutet. Wird die Liste hier gebaut, gilt genau eine Regel — diese Datei —,
 * und `tar` packt nur noch, was ihm genannt wird (`--no-recursion`).
 *
 * Verweise (Symlinks) werden als Verweis aufgenommen und nie verfolgt — so
 * wie `tar` sie ohne `-h` ablegt. Ein anderer Dateityp (Socket, Pipe, Gerät)
 * hält an: Er hat in einem Release nichts verloren, und `tar` legte ihn je
 * nach Fassung verschieden oder gar nicht ab.
 *
 * Fehlt ein oberster Eintrag, hält das ebenfalls an. Bis 2026-09-30 wurde er
 * still übergangen (`filter(existsSync)`) — ein Artefakt ohne
 * `ecosystem.config.js` wäre als vollständig durchgegangen.
 */
export function eintraegeSammeln(wurzel: string, oberste: readonly string[], distDir: string): Baumaufnahme {
  const eintraege: string[] = [];
  const ausgeschlossen: Baumaufnahme['ausgeschlossen'] = [];

  const aufnehmen = (pfad: string) => {
    if (STEUERZEICHEN.test(pfad)) {
      throw new Error(`Ein Dateiname enthält ein Steuerzeichen: ${JSON.stringify(pfad)} — so kann das Archiv nicht geprüft werden.`);
    }
    eintraege.push(pfad);
  };

  const ablaufen = (eintrag: string, verzeichnis: string) => {
    let kinder: Dirent[];
    try {
      kinder = readdirSync(join(wurzel, verzeichnis), { withFileTypes: true });
    } catch (fehler) {
      throw new Error(`${verzeichnis} lässt sich nicht lesen: ${fehler instanceof Error ? fehler.message : String(fehler)}`);
    }
    kinder.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const kind of kinder) {
      const pfad = `${verzeichnis}/${kind.name}`;
      const grund = ausschlussGrund({ eintrag, pfad, distDir });
      if (grund) {
        ausgeschlossen.push({ pfad, grund });
        continue;
      }
      if (kind.isDirectory()) {
        aufnehmen(pfad);
        ablaufen(eintrag, pfad);
      } else if (kind.isFile() || kind.isSymbolicLink()) {
        aufnehmen(pfad);
      } else {
        throw new Error(`${pfad} ist weder Datei noch Verzeichnis noch Verweis — so etwas gehört in kein Release.`);
      }
    }
  };

  for (const eintrag of oberste) {
    let info;
    try {
      info = lstatSync(join(wurzel, eintrag));
    } catch {
      throw new Error(`${eintrag} fehlt im Arbeitsbaum — das Artefakt wäre unvollständig.`);
    }
    aufnehmen(eintrag);
    if (info.isDirectory()) ablaufen(eintrag, eintrag);
    else if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`${eintrag} ist weder Datei noch Verzeichnis noch Verweis.`);
    }
  }
  return { eintraege, ausgeschlossen };
}

// ===========================================================================
//  tar — Aufruf je Fassung
// ===========================================================================

export type TarArt = 'gnu' | 'bsd';

/**
 * Welche tar-Fassung antwortet (`tar --version`, erste Zeile genügt).
 *
 * GNU tar steht auf den Linux-Rechnern der CI und des Servers, bsdtar ist das
 * `tar.exe` von Windows. Eine dritte (BusyBox) kennt weder die
 * Normalisierung noch `-T` zuverlässig — sie wird abgewiesen statt erraten.
 */
export function tarArtErkennen(versionsausgabe: string): TarArt | null {
  if (/\bGNU tar\b/.test(versionsausgabe)) return 'gnu';
  if (/\bbsdtar\b/.test(versionsausgabe)) return 'bsd';
  return null;
}

export interface TarAufruf {
  art: TarArt;
  /** Argumente für `tar` beim Packen; Arbeitsverzeichnis ist die Wurzel des Repositories. */
  argumente: string[];
  /** Inhalt der Namensliste, die unter `listenDatei` abgelegt wird. */
  liste: string;
  /** Argumente für `gzip` hinter `tar` (GNU), oder `null`, wenn `tar` selbst komprimiert (bsdtar). */
  gzip: string[] | null;
  /** Ob das Archiv für denselben Stand bytegleich entsteht. */
  normalisiert: boolean;
  /** Argumente, um das fertige Archiv aufzulisten. */
  auflisten: string[];
}

/**
 * Wie gepackt wird — je tar-Fassung ein Aufruf, als Daten, damit die Prüfung
 * ihn ohne Packen ansehen kann.
 *
 * **GNU tar (CI, Linux): reproduzierbar.** Zwei Läufe über denselben Commit
 * sollen dieselbe SHA-256 ergeben; nur dann beweist ein Nachbau, dass das
 * Archiv aus diesem Stand stammt. Dafür (Empfehlung von reproducible-builds.org
 * und dem GNU-tar-Handbuch, „Making tar Archives More Reproducible"):
 *
 *  • `--sort=name` und eine sortierte Liste — keine Reihenfolge des
 *    Dateisystems;
 *  • `--mtime=@<Commitzeit>` — jede Datei trägt die Zeit des Commits, nicht die
 *    des Auscheckens oder Bauens;
 *  • `--owner=0 --group=0 --numeric-owner` — kein Benutzer des CI-Rechners;
 *  • `--format=posix` mit `delete=atime,delete=ctime` — die Zugriffs- und
 *    Änderungszeiten stünden sonst in den erweiterten Köpfen, und
 *    `exthdr.name=%d/PaxHeaders/%f` — ältere Fassungen setzten die
 *    Prozessnummer (`%p`) in den Kopfnamen;
 *  • `gzip -n` — ohne `-n` schreibt gzip Namen und Zeit der Eingabe in den
 *    Kopf, und dieselben Bytes ergäben jede Minute eine andere Summe.
 *
 * Das Manifest kommt mit `-C <Zwischenverzeichnis> RELEASE.json` hinzu:
 * Geschrieben wird es nie in die Wurzel des Repositories (dort läge es beim
 * nächsten `git status` als Änderung, und ein abgebrochener Lauf liesse es
 * liegen). GNU tar verarbeitet `-T` und `-C` in der Reihenfolge der
 * Kommandozeile — die Liste gilt relativ zur Wurzel, das Manifest relativ zum
 * Zwischenverzeichnis.
 *
 * **bsdtar (Windows): nur eine Probe.** bsdtar kennt keine dieser
 * Normalisierungen, und ein `-C` auf der Kommandozeile wirkte schon vor der
 * Liste. Der Wechsel steht deshalb in der Liste selbst (eine Zeile `-C`, dann
 * das Verzeichnis — so liest bsdtar `-T`), und das Beiblatt sagt
 * `archivNormalisiert: false`. Auslieferbar ist ein solches Archiv ohnehin
 * nie: Es hat keine CI-Herkunft.
 */
export function tarAufruf(o: {
  art: TarArt;
  archiv: string;
  listenDatei: string;
  manifestVerzeichnis: string;
  eintraege: readonly string[];
  quelleEpoche: number;
}): TarAufruf {
  if (!Number.isSafeInteger(o.quelleEpoche) || o.quelleEpoche < 0) {
    throw new Error(`Ungültige Commitzeit für das Archiv: ${o.quelleEpoche}`);
  }
  if (o.art === 'gnu') {
    return {
      art: 'gnu',
      argumente: [
        '--format=posix',
        '--pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime',
        '--sort=name',
        `--mtime=@${o.quelleEpoche}`,
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '--no-recursion',
        '--null',
        '--verbatim-files-from',
        '-cf',
        '-',
        '-T',
        o.listenDatei,
        '-C',
        o.manifestVerzeichnis,
        MANIFEST_DATEI,
      ],
      // NUL-getrennt: kein Name kann die Liste aufbrechen, und
      // `--verbatim-files-from` verhindert, dass ein Name mit `-` als Option
      // gelesen wird.
      liste: o.eintraege.map((e) => `${e}\0`).join(''),
      gzip: ['-n'],
      normalisiert: true,
      // `literal`: GNU tar maskiert sonst Zeichen je nach Gebietsschema, und
      // der Abgleich vergliche Maskiertes mit Unmaskiertem. `--force-local`:
      // Ein Archivname mit Doppelpunkt (`C:\…` unter Windows mit GNU tar aus
      // Git) gälte sonst als entfernter Rechner.
      auflisten: ['--force-local', '--quoting-style=literal', '-tzf', o.archiv],
    };
  }
  return {
    art: 'bsd',
    argumente: ['-czf', o.archiv, '-n', '-T', o.listenDatei],
    liste: [...o.eintraege, '-C', o.manifestVerzeichnis, MANIFEST_DATEI].map((z) => `${z}\n`).join(''),
    gzip: null,
    normalisiert: false,
    auflisten: ['-tzf', o.archiv],
  };
}

// ===========================================================================
//  Gegenproben am fertigen Archiv
// ===========================================================================

/** Die Ausgabe von `tar -tzf` als Liste, in derselben Schreibweise wie `eintraegeSammeln`. */
export function archivlisteLesen(ausgabe: string): string[] {
  return ausgabe
    .split(/\r?\n/)
    .filter((zeile) => zeile.length > 0)
    .map((zeile) => zeile.replace(/^\.\//, '').replace(/\/+$/, ''));
}

export interface Vollstaendigkeit {
  /** Erwartet, aber nicht im Archiv. */
  fehlend: string[];
  /** Im Archiv, aber nie verlangt. */
  ueberzaehlig: string[];
  /** Mehr als einmal im Archiv. */
  doppelt: string[];
}

/**
 * Enthält das Archiv genau, was gepackt werden sollte?
 *
 * `tar` kann Einträge verlieren, ohne dass es auffällt: eine Datei, die
 * zwischen Ablaufen und Packen verschwand, ein Leserecht, eine Warnung, die in
 * der CI-Ausgabe untergeht. Das Archiv wäre dann nicht der geprüfte Baum, und
 * die Summe bewiese nur, dass *dieses* unvollständige Archiv unverändert
 * ankommt. Deshalb wird nach dem Packen die Liste des Archivs mit der
 * erwarteten verglichen — in beide Richtungen, und doppelte Einträge zählen
 * mit (beim Entpacken gewänne der letzte, und welcher das ist, sähe niemand).
 *
 * `erwartet` ist die Ausgabe von `eintraegeSammeln` plus `RELEASE.json` —
 * also der Baum ohne genau die verankerten Ausschlüsse, nichts sonst.
 */
export function vollstaendigkeitPruefen(erwartet: readonly string[], gelistet: readonly string[]): Vollstaendigkeit {
  const imArchiv = new Map<string, number>();
  for (const e of gelistet) imArchiv.set(e, (imArchiv.get(e) ?? 0) + 1);
  const verlangt = new Set(erwartet);
  return {
    fehlend: erwartet.filter((e) => !imArchiv.has(e)),
    ueberzaehlig: [...imArchiv.keys()].filter((e) => !verlangt.has(e)),
    doppelt: [...imArchiv.entries()].filter(([, n]) => n > 1).map(([e]) => e),
  };
}

export function vollstaendig(v: Vollstaendigkeit): boolean {
  return v.fehlend.length === 0 && v.ueberzaehlig.length === 0 && v.doppelt.length === 0;
}

/**
 * Umgebungsdateien im fertigen Archiv — ausserhalb von `node_modules`.
 *
 * Die Ausschlüsse greifen nur oben (siehe `ausschlussGrund`). Liegt eine
 * `.env` tiefer, etwa `src/lib/.env.local`, ist sie vermutlich ein Versehen mit
 * Geheimnissen darin — ignoriert von Git, also auch von der
 * Sauberkeitsprüfung unbemerkt. Sie wird nicht still weggelassen (dann
 * stimmte der Abgleich nicht mehr), sondern das Artefakt wird verweigert.
 * Ein Paket unter `node_modules`, das eine `.env` mitbringt, gehört dem Paket;
 * sie zu entfernen hiesse, den geprüften Baum zu verändern.
 */
export function umgebungsdateienImArchiv(gelistet: readonly string[]): string[] {
  return gelistet.filter((e) => {
    const teile = e.split('/');
    return teile[0] !== 'node_modules' && teile.some((teil) => UMGEBUNGSDATEI.test(teil));
  });
}

// ===========================================================================
//  Herkunft: Commit, Sauberkeit, CI
// ===========================================================================

/**
 * Welcher Commit gebaut wurde.
 *
 * In der CI nennt `GITHUB_SHA` den Commit des Laufs, örtlich zählt `HEAD`.
 * Stehen beide fest und widersprechen sich, hat der Lauf etwas anderes
 * ausgecheckt, als er meldet — das Manifest nennte dann einen Commit, aus dem
 * nicht gebaut wurde. Das hält an, statt einem der beiden zu glauben.
 */
export function commitBestimmen(githubSha: string | undefined, kopf: string): string {
  const gemeldet = githubSha?.trim() ?? '';
  const ausgecheckt = kopf.trim();
  if (!COMMIT_MUSTER.test(ausgecheckt)) throw new Error(`HEAD ist kein vollständiger Commit: ${JSON.stringify(ausgecheckt)}`);
  if (gemeldet) {
    if (!COMMIT_MUSTER.test(gemeldet)) throw new Error(`GITHUB_SHA ist kein vollständiger Commit: ${JSON.stringify(gemeldet)}`);
    if (gemeldet !== ausgecheckt) {
      throw new Error(`GITHUB_SHA (${gemeldet}) ist nicht der ausgecheckte Commit (${ausgecheckt}) — gebaut wurde etwas anderes, als der Lauf meldet.`);
    }
  }
  return ausgecheckt;
}

/**
 * Welche Pfade den Baum unsauber machen — aus `git status --porcelain=v1 -z
 * --untracked-files=all`.
 *
 *  • **Jede Änderung an einer verfolgten Datei**, wo auch immer: Das Manifest
 *    sagt „aus Commit X", und eine geänderte Datei — auch ausserhalb des
 *    Artefakts, etwa eine Bau-Einstellung — hätte X nie gesehen.
 *  • **Unverfolgte Dateien in den Einträgen des Artefakts.** Bis 2026-09-30
 *    zählten sie nicht (`--untracked-files=no`): Eine neue Datei unter `src/`,
 *    nie eingecheckt, reiste mit, und niemand hätte sie aus dem Commit
 *    nachbauen können. Unverfolgtes ausserhalb (eigene Berichte unter
 *    `docs/`, Entwürfe) landet nicht im Archiv und zählt deshalb nicht.
 *
 * Von Git ignorierte Dateien erscheinen hier nie — `.next` und `node_modules`
 * sind Erzeugnisse und gehören trotzdem hinein. Eine ignorierte Umgebungsdatei
 * tief in `src/` fängt die Gegenprobe am Archiv (`umgebungsdateienImArchiv`).
 *
 * `-z` statt Zeilen: keine Anführungszeichen um ungewöhnliche Namen, und bei
 * Umbenennungen (`R`, `C`) folgt der alte Pfad als eigener, NUL-getrennter
 * Eintrag — er wird übersprungen, gezählt wird der neue.
 */
export function unsauberePfade(porcelainZ: string, oberste: readonly string[]): string[] {
  const teile = porcelainZ.split('\0');
  const liegtImArtefakt = (pfad: string) => oberste.some((o) => pfad === o || pfad.startsWith(`${o}/`));
  const befund: string[] = [];
  for (let i = 0; i < teile.length; i++) {
    const satz = teile[i]!;
    if (satz.length < 4) continue;
    const xy = satz.slice(0, 2);
    const pfad = satz.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') i++;
    if (xy === '!!') continue;
    if (xy === '??') {
      if (liegtImArtefakt(pfad.replace(/\/+$/, ''))) befund.push(pfad);
      continue;
    }
    befund.push(pfad);
  }
  return befund;
}

/**
 * Die Herkunft aus der CI — oder `null` für einen örtlichen Bau.
 *
 * Massgebend ist `GITHUB_RUN_ID`: Ohne sie gibt es keinen Lauf, auf den sich
 * jemand berufen könnte. Ist sie gesetzt, müssen **alle** Angaben da und
 * gültig sein. Die Alternative — fehlende Werte still als „örtlich" zu werten —
 * machte aus einem falsch eingerichteten Lauf eine Probe, und niemand merkte,
 * warum die Auslieferung „nichts Auslieferbares" findet.
 */
export function ciHerkunftAusUmgebung(env: Record<string, string | undefined>): CiHerkunft | null {
  const lauf = env.GITHUB_RUN_ID?.trim();
  if (!lauf) return null;
  const roh = {
    lauf,
    versuch: env.GITHUB_RUN_ATTEMPT?.trim() ?? '',
    ereignis: env.GITHUB_EVENT_NAME?.trim() ?? '',
    ref: env.GITHUB_REF?.trim() ?? '',
    repository: env.GITHUB_REPOSITORY?.trim() ?? '',
  };
  const ergebnis = ciHerkunftSchema.safeParse(roh);
  if (!ergebnis.success) {
    const namen: Record<string, string> = {
      lauf: 'GITHUB_RUN_ID',
      versuch: 'GITHUB_RUN_ATTEMPT',
      ereignis: 'GITHUB_EVENT_NAME',
      ref: 'GITHUB_REF',
      repository: 'GITHUB_REPOSITORY',
    };
    const felder = [...new Set(ergebnis.error.issues.map((f) => namen[String(f.path[0])] ?? String(f.path[0])))];
    throw new Error(`GITHUB_RUN_ID ist gesetzt, aber die CI-Herkunft ist unvollständig oder ungültig: ${felder.join(', ')}.`);
  }
  return ergebnis.data;
}

/**
 * Die Commitzeit aus `git show -s --format=%cI` — als UTC-Zeitpunkt für das
 * Manifest und als Sekunden seit 1970 für `tar --mtime`.
 *
 * Die Commitzeit statt der Packzeit: Sie ist für denselben Stand immer
 * dieselbe, das Manifest (und mit ihm das Archiv) also reproduzierbar. Die
 * Packzeit steht nur im Beiblatt (`erstelltUtc`) und wird nie verglichen.
 * `%cI` trägt die Zone des Committers (`+02:00`); der Vertrag verlangt UTC.
 */
export function quelleZeit(cI: string): { utc: string; epoche: number } {
  const ms = Date.parse(cI.trim());
  if (!Number.isFinite(ms)) throw new Error(`Die Commitzeit ist nicht lesbar: ${JSON.stringify(cI)}`);
  return { utc: new Date(ms).toISOString(), epoche: Math.floor(ms / 1000) };
}

/**
 * Die Migrationsverzeichnisse, sortiert — nur solche mit `migration.sql`
 * (ein leeres Verzeichnis ist für Prisma keine Migration). Ein Name ausserhalb
 * des Musters hält hier mit Namen an, statt als unverständlicher
 * Schemafehler im Manifest zu enden: Release Center und Datenbank gleichen
 * diese Liste Namen für Namen ab.
 */
export function migrationenAuflisten(verzeichnis: string): string[] {
  const namen = readdirSync(verzeichnis, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(verzeichnis, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort();
  const falsch = namen.filter((n) => !MIGRATION_MUSTER.test(n));
  if (falsch.length > 0) {
    throw new Error(`Migrationsverzeichnis ausserhalb des Musters ${MIGRATION_MUSTER}: ${falsch.join(', ')}`);
  }
  return namen;
}

// ===========================================================================
//  Manifest und Beiblatt
// ===========================================================================

export interface ManifestFelder {
  version: string;
  commit: string;
  unsauber: boolean;
  buildId: string;
  distDir: string;
  quelleZeitUtc: string;
  node: string;
  npm: string;
  plattform: string;
  next: string;
  sperrdateiSha256: string;
  seitenUrl: string | null;
  mitModulen: boolean;
  migrationen: string[];
  ci: CiHerkunft | null;
}

function vertragsfehler(was: string, fehler: { issues: { path: PropertyKey[]; message: string }[] }): Error {
  const liste = fehler.issues.map((f) => `${f.path.map(String).join('.') || '(Wurzel)'}: ${f.message}`).join('; ');
  return new Error(`${was} verletzt den Vertrag in src/lib/release/manifest.ts — ${liste}`);
}

/**
 * `RELEASE.json` bauen und gegen den Vertrag parsen.
 *
 * `reactKorrektur: 'geprueft'` steht fest, weil das Packskript diese Funktion
 * erst nach bestandener Prüfung ruft. `auslieferbar` wird nie übergeben,
 * sondern aus derselben Regel abgeleitet, die Aktivierung, Vorprüfung und
 * Ausführer anwenden (`auslieferbarNach`) — ein zweiter, eigener Ausdruck
 * hier war bis Format 1 genau die Stelle, an der ein Leser „auslieferbar" und
 * der nächste „Probe" sah.
 *
 * Die Schlüssel stehen in der Reihenfolge des Vertrags, damit zwei Manifeste
 * derselben Fassung auch als Text gleich sind.
 */
export function manifestBauen(f: ManifestFelder): ArtefaktManifest {
  const roh = {
    format: MANIFEST_FORMAT,
    anwendung: 'clenaris' as const,
    version: f.version,
    commit: f.commit,
    unsauber: f.unsauber,
    buildId: f.buildId,
    distDir: f.distDir,
    quelleZeitUtc: f.quelleZeitUtc,
    node: f.node,
    npm: f.npm,
    plattform: f.plattform,
    next: f.next,
    sperrdateiSha256: f.sperrdateiSha256,
    seitenUrl: f.seitenUrl,
    reactKorrektur: 'geprueft' as const,
    mitModulen: f.mitModulen,
    migrationen: f.migrationen,
    ci: f.ci,
    auslieferbar: auslieferbarNach(f),
  };
  const ergebnis = artefaktManifestSchema.safeParse(roh);
  if (!ergebnis.success) throw vertragsfehler('Das Manifest', ergebnis.error);
  return ergebnis.data;
}

/**
 * Das Beiblatt neben dem Archiv: das Manifest und, was erst nach dem Packen
 * feststeht. Ebenfalls geparst — der Ausführer liest es, bevor er ein Archiv
 * beansprucht, und ein Beiblatt, das dort scheitert, fiele erst auf dem Weg
 * zur Produktion auf.
 */
export function beilageBauen(
  manifest: ArtefaktManifest,
  archiv: { archivSha256: string; archivGroesseBytes: number; erstelltUtc: string; archivNormalisiert: boolean },
): ArtefaktBeilage {
  const ergebnis = artefaktBeilageSchema.safeParse({ ...manifest, ...archiv });
  if (!ergebnis.success) throw vertragsfehler('Das Beiblatt', ergebnis.error);
  return ergebnis.data;
}

/**
 * Der Dateiname ohne Endung. Die ersten zwölf Zeichen des Commits genügen zum
 * Wiederfinden; massgebend bleibt der volle Commit im Manifest. `-probe`
 * kennzeichnet ein Archiv ohne Module schon am Namen — der Ausführer sucht
 * `clenaris-<sha12>.tar.gz` und findet eine Probe deshalb gar nicht erst.
 */
export function artefaktName(commit: string, mitModulen: boolean): string {
  return `clenaris-${commit.slice(0, 12)}${mitModulen ? '' : '-probe'}`;
}

// ===========================================================================
//  Stolperfalle: Demodaten im Bau
// ===========================================================================

/** Endungen der vorgerenderten Ausgaben unter `<distDir>/server`, in denen Daten aus der Datenbank landen. */
export const DEMO_SUCHENDUNGEN = ['.html', '.rsc', '.body', '.json', '.meta', '.xml', '.txt'] as const;

/** Erzeugte Dateien unter `public/`, die ebenfalls Inhalte der Datenbank tragen könnten (Sitemap, robots). */
const OEFFENTLICH_ERZEUGT = /^(sitemap.*\.xml|robots\.txt)$/;

/**
 * Die Dateien, in denen Demodaten auftauchen könnten: alles Vorgerenderte
 * unter `<distDir>/server` (Seiten als `.html`/`.rsc`, Routen wie die Sitemap
 * als `.body`/`.meta`, Manifeste als `.json`), das Vorrender-Manifest mit den
 * Pfaden der Blogbeiträge und erzeugte Sitemaps unter `public/`.
 *
 * Nicht durchsucht werden `.js`-Bündel: Sie enthalten Code, keine Daten der
 * Datenbank — und Code darf Demoadressen kennen, etwa die Liste
 * veröffentlichter Zugangsdaten, die die Anmeldung in der Produktion sperrt
 * (`src/lib/auth/oeffentliche-zugangsdaten.ts`). Ein Treffer dort wäre ein
 * Fehlalarm bei jedem Bau.
 */
export function demoSuchorte(wurzel: string, distDir: string): string[] {
  const orte: string[] = [];
  const server = `${distDir}/server`;
  const ablaufen = (verzeichnis: string) => {
    let kinder: Dirent[];
    try {
      kinder = readdirSync(join(wurzel, verzeichnis), { withFileTypes: true });
    } catch {
      return;
    }
    for (const kind of kinder) {
      const pfad = `${verzeichnis}/${kind.name}`;
      if (kind.isDirectory()) ablaufen(pfad);
      else if (kind.isFile() && DEMO_SUCHENDUNGEN.some((endung) => kind.name.endsWith(endung))) orte.push(pfad);
    }
  };
  ablaufen(server);
  if (existsSync(join(wurzel, distDir, 'prerender-manifest.json'))) orte.push(`${distDir}/prerender-manifest.json`);
  try {
    for (const kind of readdirSync(join(wurzel, 'public'), { withFileTypes: true })) {
      if (kind.isFile() && OEFFENTLICH_ERZEUGT.test(kind.name)) orte.push(`public/${kind.name}`);
    }
  } catch {
    // Ohne `public/` gibt es dort nichts zu durchsuchen; dass es fehlt, meldet `eintraegeSammeln`.
  }
  return orte.sort();
}

const BENANNTE_ZEICHEN: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Ein Codepunkt als Zeichen — ausserhalb des Unicode-Bereichs bleibt die Schreibweise stehen, statt die Suche abzubrechen. */
function zeichen(codepunkt: number, schreibweise: string): string {
  return Number.isInteger(codepunkt) && codepunkt >= 0 && codepunkt <= 0x10ffff ? String.fromCodePoint(codepunkt) : schreibweise;
}

/**
 * Text so herrichten, wie ein Mensch ihn läse — sonst verfehlte die Suche
 * einen Treffer an der Schreibweise statt am Inhalt:
 *
 *  • `<!-- -->` entfernen: React setzt diesen Trenner zwischen zwei
 *    benachbarte Textausdrücke, aus „Nicole Wyss" wird im HTML
 *    `Nicole<!-- --> <!-- -->Wyss`;
 *  • HTML-Zeichen auflösen (`&amp;`, `&#x27;`, `&#39;` …) — React maskiert
 *    Apostrophe und Ampersands;
 *  • `\uXXXX` auflösen — JSON und RSC schreiben manche Zeichen so.
 */
export function textFuerSuche(roh: string): string {
  return roh
    .replace(/<!-- -->/g, '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (ganz, hex: string) => zeichen(Number.parseInt(hex, 16), ganz))
    .replace(/&#(\d{1,7});/g, (ganz, dez: string) => zeichen(Number.parseInt(dez, 10), ganz))
    .replace(/&([a-z]+);/g, (ganz, name: string) => BENANNTE_ZEICHEN[name] ?? ganz);
}

export interface Demotreffer {
  /** Pfad relativ zur Wurzel des Repositories. */
  datei: string;
  /** Welche Arten von Kennzeichen getroffen wurden — nie die Werte selbst. */
  arten: string[];
}

/**
 * Den Bau nach Demodaten durchsuchen (`prisma/demo-kennzeichen.ts`).
 *
 * Geprüft werden Inhalt **und** Pfad: Ein vorgerenderter Blogbeitrag liegt
 * als `server/app/blog/<slug>.html` — schon der Name verrät ihn.
 */
export function demodatenSuchen(
  wurzel: string,
  distDir: string,
  kennzeichen: readonly Demokennzeichen[] = DEMO_KENNZEICHEN,
): Demotreffer[] {
  const treffer: Demotreffer[] = [];
  for (const datei of demoSuchorte(wurzel, distDir)) {
    const text = `${datei}\n${textFuerSuche(readFileSync(join(wurzel, datei), 'utf8'))}`;
    const arten = [...new Set(kennzeichen.filter((k) => text.includes(k.text)).map((k) => k.art))].sort();
    if (arten.length > 0) treffer.push({ datei, arten });
  }
  return treffer;
}

/**
 * Die Meldung, mit der das Packen verweigert wird. Sie nennt Dateien und die
 * Art des Treffers, **nicht** den getroffenen Wert: Die Ausgabe landet im
 * öffentlich lesbaren CI-Protokoll, und wer den Befund beheben will, braucht
 * die Datei, nicht den Namen einer erfundenen Kundin.
 */
export function demodatenMeldung(treffer: readonly Demotreffer[], hoechstens = 20): string {
  const zeilen = treffer.slice(0, hoechstens).map((t) => `  ${t.datei} (${t.arten.join(', ')})`);
  if (treffer.length > hoechstens) zeilen.push(`  … und ${treffer.length - hoechstens} weitere`);
  return [
    `Demodaten im Bau — Packen verweigert. ${treffer.length} Datei(en) enthalten Kennzeichen aus prisma/demo-kennzeichen.ts:`,
    ...zeilen,
    'Der Bau lief gegen eine Datenbank mit Demobestand (npm run db:seed:demo); die vorgerenderte Website trüge erfundene',
    'Bewertungen und Beispielartikel in die Produktion. Ein Artefakt entsteht aus einem Bau gegen eine Datenbank ohne',
    'Demobestand (Konfigurations-Seed: npm run db:seed).',
  ].join('\n');
}
