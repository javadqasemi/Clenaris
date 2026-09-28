import { ValidationError } from '@/lib/errors';

/**
 * Dateipolitik — was ein Name und eine Endung bedeuten dürfen.
 *
 * ---------------------------------------------------------------------------
 *  Abgrenzung: was hier NICHT geprüft wird
 * ---------------------------------------------------------------------------
 *
 * Der **Inhalt**. Den prüft `verifyBytes` in `profiles.ts` gegen die
 * Signatur, und die Schadsoftwareprüfung prüft ihn gegen einen Prüfer. Dieses
 * Modul betrifft ausschliesslich das, was um die Bytes herumsteht: Name,
 * Endung und der angemeldete Typ.
 *
 * Das klingt nebensächlich und ist es nicht. Eine Datei, deren Inhalt
 * nachweislich ein PDF ist, aber `rechnung.pdf.exe` heisst, ist harmlos,
 * solange sie in unserem Speicher liegt — und gefährlich in dem Moment, in
 * dem jemand sie herunterlädt und doppelklickt. Windows zeigt bekannte
 * Endungen standardmässig nicht an; im Ordner steht dann `rechnung.pdf`.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine Verbotsliste UND eine Erlaubnisliste
 * ---------------------------------------------------------------------------
 *
 * Die Erlaubnisliste (`ENDUNGEN_JE_TYP`) beantwortet: Passt die Endung zum
 * nachgewiesenen Typ? Sie ist die eigentliche Regel.
 *
 * Die Verbotsliste (`GEFAEHRLICHE_ENDUNGEN`) beantwortet eine andere Frage:
 * Steht **irgendwo** im Namen eine Endung, die ein Betriebssystem ausführen
 * würde? Sie greift auch dort, wo die Erlaubnisliste zufrieden wäre — bei
 * `foto.jpg.bat` etwa ist die letzte Endung nicht `.jpg`, aber bei
 * `foto.bat.jpg` ist sie es, und trotzdem will man den Namen nicht.
 *
 * Eine Liste allein liesse jeweils die andere Hälfte offen.
 */

/**
 * Endungen, die zu einem nachgewiesenen Typ passen.
 *
 * Die Liste ist die Umkehrung von `UPLOAD_PROFILES`: Sie deckt genau die
 * Typen ab, die überhaupt angenommen werden. Ein Typ ohne Eintrag hier wäre
 * ein Typ, den ein Profil erlaubt und diese Politik nicht kennt — deshalb
 * prüft `endungenVollstaendig()` in den Tests beide Listen gegeneinander.
 */
export const ENDUNGEN_JE_TYP: Record<string, readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/avif': ['avif'],
  'image/heic': ['heic', 'heif'],
  'application/pdf': ['pdf'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
};

/**
 * Endungen, die nirgends im Dateinamen vorkommen dürfen.
 *
 * Drei Gruppen, jede mit eigenem Grund:
 *
 *  • **Ausführbares und Skripte** — was ein Betriebssystem oder eine Shell
 *    startet, wenn jemand doppelklickt.
 *  • **Makrofähige Office-Formate** — `.docm`, `.xlsm` und Verwandte tragen
 *    ausführbaren Code. Die Profile erlauben ohnehin nur die makrofreien
 *    OOXML-Typen; diese Zeile sorgt dafür, dass der *Name* nicht behauptet,
 *    etwas anderes zu sein.
 *  • **Aktive Web-Inhalte** — `.svg` und `.html` sind Dokumente, die
 *    Skripte ausführen können, sobald ein Browser sie im eigenen Ursprung
 *    öffnet. Kein Profil erlaubt sie; die Endung bleibt trotzdem verboten,
 *    damit sie nicht über einen Namen hereinkommt.
 */
export const GEFAEHRLICHE_ENDUNGEN: ReadonlySet<string> = new Set([
  // Ausführbares
  'exe', 'com', 'scr', 'pif', 'cpl', 'msi', 'msp', 'msc', 'dll', 'sys', 'drv',
  'app', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'jar', 'bin', 'elf',
  // Skripte
  'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'mjs', 'cjs',
  'wsf', 'wsh', 'hta', 'sh', 'bash', 'zsh', 'py', 'pl', 'rb', 'php', 'lnk', 'url', 'reg',
  // Makrofähige Office-Formate
  'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'sldm',
  // Aktive Web-Inhalte
  'svg', 'svgz', 'html', 'htm', 'xhtml', 'shtml', 'mhtml', 'mht', 'xml', 'xsl', 'xslt',
]);

/**
 * MIME-Typen, die nie angenommen werden — unabhängig vom Profil.
 *
 * Doppelter Boden zu den Profillisten: Käme ein Typ je über eine neue
 * Profilzeile herein, greift diese Liste trotzdem.
 */
/**
 * **Durchgehend kleingeschrieben.** MIME-Typen sind nach RFC 2045 in Typ und
 * Untertyp case-insensitiv, und die makrofähigen Office-Typen tragen
 * ausgerechnet ein grosses `E` in `macroEnabled`. Ein Vergleich gegen die
 * Schreibweise aus der Registry hätte genau diese drei Typen durchgelassen —
 * die einzigen in dieser Liste, auf die es fachlich wirklich ankommt.
 *
 * Der Vergleich kleinschreiben beide Seiten; `pruefeDateipolitik` senkt den
 * Eingabewert, hier steht er schon gesenkt.
 */
export const GEFAEHRLICHE_TYPEN: ReadonlySet<string> = new Set(
  [
    'image/svg+xml',
    'text/html',
    'application/xhtml+xml',
    'application/xml',
    'text/xml',
    'application/x-msdownload',
    'application/x-msdos-program',
    'application/x-executable',
    'application/x-sh',
    'application/javascript',
    'text/javascript',
    'application/vnd.ms-word.document.macroEnabled.12',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    'application/vnd.ms-word.template.macroEnabled.12',
    'application/vnd.ms-excel.template.macroEnabled.12',
    'application/vnd.ms-excel.addin.macroEnabled.12',
  ].map((t) => t.toLowerCase()),
);

/**
 * Archivgrenzen.
 *
 * **Heute erlaubt kein Profil ein Archiv** — weder ZIP noch RAR noch 7z. Die
 * Grenzen stehen trotzdem hier, und zwar aus einem Grund, der sich sonst
 * erst im Schadensfall zeigt: Wer später ein Archivformat in ein Profil
 * schreibt, ändert eine Zeile in `profiles.ts` und denkt dabei nicht an
 * Dekompression. Dann greifen diese Werte bereits.
 *
 * Entpackt wird **nicht** in dieser Anwendung. Archive gehen ungeöffnet an
 * den Prüfer; `clamd` entpackt selbst und hat dafür eigene Grenzen
 * (`MaxScanSize`, `MaxFileSize`, `MaxRecursion`, `MaxFiles`). Die Werte hier
 * sind unsere Vorgabe an dessen Konfiguration — sie stehen in
 * `docs/MALWARE_PROTECTION.md` und werden dort gegen die tatsächliche
 * `clamd.conf` abgeglichen.
 */
export const ARCHIV_GRENZEN = {
  /** Grösse des Archivs selbst. */
  maxKomprimiertBytes: 64 * 1024 * 1024,
  /** Summe der entpackten Inhalte. */
  maxEntpacktBytes: 512 * 1024 * 1024,
  /** Entpackt zu komprimiert. Darüber ist es eine Bombe, kein Archiv. */
  maxVerhaeltnis: 100,
  /** Anzahl Einträge. */
  maxEintraege: 2_000,
  /** Verschachtelungstiefe. */
  maxTiefe: 4,
} as const;

/** Archivtypen — heute von keinem Profil erlaubt, hier benannt. */
export const ARCHIV_TYPEN: ReadonlySet<string> = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-rar-compressed',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-bzip2',
]);

/** Alle Endungen eines Namens, in Kleinschrift, ohne Punkt. */
export function endungen(filename: string): string[] {
  const basis = filename.split(/[/\\]/).pop() ?? '';
  const teile = basis.split('.');
  if (teile.length < 2) return [];
  return teile.slice(1).map((t) => t.toLowerCase().trim()).filter(Boolean);
}

/** Die letzte Endung — die, nach der ein Betriebssystem entscheidet. */
export function letzteEndung(filename: string): string | null {
  const alle = endungen(filename);
  return alle.length > 0 ? alle[alle.length - 1] : null;
}

export interface PolitikBefund {
  /** Die Endung, nach der ausgeliefert wird. */
  endung: string | null;
  /** Mehr als eine Endung im Namen. Für sich genommen kein Fehler. */
  mehrfachEndung: boolean;
}

/**
 * Name und Typ gegen die Politik prüfen.
 *
 * Wirft `ValidationError` mit einer Meldung, die der hochladenden Person
 * sagt, was zu tun ist — und nichts darüber verrät, wie die Prüfung
 * aufgebaut ist.
 *
 * Reihenfolge: gefährlicher Typ, gefährliche Endung irgendwo, Archiv,
 * fehlende Endung, Endung passt nicht zum Typ. Vom Eindeutigen zum
 * Feineren, damit die Meldung die nächstliegende Ursache nennt.
 */
export function pruefeDateipolitik(filename: string, mimeType: string): PolitikBefund {
  const typ = mimeType.toLowerCase().split(';')[0].trim();

  if (GEFAEHRLICHE_TYPEN.has(typ)) {
    throw new ValidationError('Dieser Dateityp wird aus Sicherheitsgründen nicht angenommen.');
  }

  const alle = endungen(filename);

  for (const e of alle) {
    if (GEFAEHRLICHE_ENDUNGEN.has(e)) {
      /**
       * Die Meldung nennt die Endung. Das ist Absicht: Wer eine Datei
       * `bericht.pdf.exe` hochlädt, hat sie meist nicht so benannt — er hat
       * sie so bekommen. Der Hinweis auf die Endung ist dann die nützlichste
       * Auskunft, die wir geben können.
       */
      throw new ValidationError(
        `Dateien mit der Endung „.${e}" werden aus Sicherheitsgründen nicht angenommen.`,
      );
    }
  }

  if (ARCHIV_TYPEN.has(typ)) {
    throw new ValidationError('Archive werden nicht angenommen. Bitte die Dateien einzeln hochladen.');
  }

  const endung = letzteEndung(filename);
  if (!endung) {
    throw new ValidationError('Die Datei braucht eine Dateiendung.');
  }

  const erlaubt = ENDUNGEN_JE_TYP[typ];
  if (!erlaubt) {
    // Ein Typ, den ein Profil zulässt, den diese Politik aber nicht kennt.
    // Fail closed — und die Tests fangen den Fall, bevor er hier auftritt.
    throw new ValidationError('Dieser Dateityp wird nicht unterstützt.');
  }

  if (!erlaubt.includes(endung)) {
    throw new ValidationError(
      `Die Dateiendung „.${endung}" passt nicht zum Inhalt der Datei. ` +
        `Erwartet: ${erlaubt.map((e) => `.${e}`).join(' oder ')}.`,
    );
  }

  return { endung, mehrfachEndung: alle.length > 1 };
}
