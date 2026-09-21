import { strict as assert } from 'node:assert';
import { before, describe, it } from 'node:test';

import { BASE_URL, data, get, post } from '../helpers/client.js';
import { loginAll } from '../helpers/accounts.js';

import {
  ARCHIV_GRENZEN,
  ENDUNGEN_JE_TYP,
  GEFAEHRLICHE_ENDUNGEN,
  endungen,
  letzteEndung,
  pruefeDateipolitik,
} from '../../src/lib/storage/dateipolitik';
import { darfAusgeliefertWerden } from '../../src/lib/security/malware/auslieferung';
import {
  EICAR,
  eicarBytes,
  scanFehlerBytes,
  scanZeitlimitBytes,
  testScanner,
} from '../../src/lib/security/malware/test-scanner';

/**
 * Dateisicherheit — Politik, Prüfer und Auslieferungssperre (Wave 2).
 *
 * ---------------------------------------------------------------------------
 *  Zwei Ebenen, bewusst getrennt
 * ---------------------------------------------------------------------------
 *
 * Der obere Teil importiert Anwendungscode direkt. Das ist die Ausnahme, die
 * `tests/README.md` für reine Rechnung vorsieht, und sie gilt hier aus
 * demselben Grund wie bei der Feldverschlüsselung: Über HTTP liesse sich
 * beobachten, dass eine Datei nicht kommt — nicht, *warum*. Ob eine
 * infizierte, eine ungeprüfte und eine fehlerhafte Datei aus drei
 * verschiedenen Gründen zurückgewiesen werden oder aus Versehen alle aus
 * demselben, entscheidet über den Wert der ganzen Kette.
 *
 * Der untere Teil fährt den echten Weg: Ticket holen, Bytes schreiben,
 * abschliessen, abrufen. Nur dort zeigt sich, dass Politik, Prüfer und Sperre
 * tatsächlich hintereinanderhängen.
 *
 * ---------------------------------------------------------------------------
 *  Zur Testdatei
 * ---------------------------------------------------------------------------
 *
 * Als Fund dient **ausschliesslich EICAR** — die genormte, vollkommen
 * harmlose Testzeichenkette. Sie ist kein Schadprogramm und tut nichts. Echte
 * Schadsoftware wird hier weder erzeugt noch heruntergeladen noch ausgeführt.
 */

// ===========================================================================
//  1) Dateipolitik — Name, Endung, Typ
// ===========================================================================

describe('Dateipolitik — gefährliche Endungen', () => {
  /**
   * Der Fall, um den es geht: Der *Inhalt* ist nachweislich ein PDF, der
   * *Name* endet auf `.exe`. Im Speicher harmlos, auf dem Rechner der Person,
   * die ihn herunterlädt, nicht — Windows blendet bekannte Endungen aus, im
   * Ordner steht dann `rechnung.pdf`.
   */
  it('weist eine ausführbare Doppelendung zurück', () => {
    assert.throws(
      () => pruefeDateipolitik('rechnung.pdf.exe', 'application/pdf'),
      /\.exe/,
      'eine ausführbare Endung darf nirgends im Namen stehen',
    );
  });

  it('weist eine ausführbare Endung auch in der Mitte zurück', () => {
    // `.bat` steht nicht am Ende — ein Betriebssystem stört das nicht
    // zwangsläufig, und ein Mensch sieht es erst recht nicht.
    assert.throws(() => pruefeDateipolitik('foto.bat.jpg', 'image/jpeg'), /\.bat/);
  });

  it('weist Skriptendungen zurück', () => {
    for (const e of ['ps1', 'vbs', 'sh', 'js', 'hta', 'lnk', 'reg']) {
      assert.throws(
        () => pruefeDateipolitik(`datei.pdf.${e}`, 'application/pdf'),
        new RegExp(`\\.${e}`),
        `.${e} muss abgewiesen werden`,
      );
    }
  });

  it('weist makrofähige Office-Formate über die Endung zurück', () => {
    for (const e of ['docm', 'xlsm', 'pptm', 'xlam']) {
      assert.throws(() => pruefeDateipolitik(`mappe.${e}`, 'application/pdf'), new RegExp(`\\.${e}`));
    }
  });

  it('weist aktive Web-Inhalte über die Endung zurück', () => {
    for (const e of ['svg', 'html', 'htm', 'xhtml', 'xml']) {
      assert.throws(() => pruefeDateipolitik(`bild.${e}`, 'image/png'), new RegExp(`\\.${e}`));
    }
  });
});

describe('Dateipolitik — gefährliche Typen', () => {
  it('weist SVG und HTML als MIME-Typ zurück', () => {
    for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/javascript']) {
      assert.throws(() => pruefeDateipolitik('datei.png', t), /Sicherheitsgründen/);
    }
  });

  it('weist makrofähige Office-Typen zurück', () => {
    assert.throws(
      () => pruefeDateipolitik('mappe.xlsx', 'application/vnd.ms-excel.sheet.macroEnabled.12'),
      /Sicherheitsgründen/,
    );
  });

  it('weist Archive zurück und sagt, was stattdessen zu tun ist', () => {
    for (const t of ['application/zip', 'application/x-7z-compressed', 'application/x-tar']) {
      assert.throws(() => pruefeDateipolitik('bilder.dat', t), /einzeln hochladen/);
    }
  });
});

describe('Dateipolitik — Endung passt zum Inhalt', () => {
  it('lässt passende Kombinationen durch', () => {
    const paare: [string, string][] = [
      ['foto.jpg', 'image/jpeg'],
      ['foto.jpeg', 'image/jpeg'],
      ['bild.png', 'image/png'],
      ['rechnung.pdf', 'application/pdf'],
      ['liste.csv', 'text/csv'],
      ['notiz.txt', 'text/plain'],
      ['mappe.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ];
    for (const [name, typ] of paare) {
      const befund = pruefeDateipolitik(name, typ);
      assert.equal(befund.mehrfachEndung, false, `${name} hat nur eine Endung`);
    }
  });

  it('weist eine Endung zurück, die nicht zum nachgewiesenen Typ passt', () => {
    assert.throws(() => pruefeDateipolitik('rechnung.jpg', 'application/pdf'), /passt nicht/);
    assert.throws(() => pruefeDateipolitik('foto.pdf', 'image/png'), /passt nicht/);
  });

  it('verlangt überhaupt eine Endung', () => {
    assert.throws(() => pruefeDateipolitik('rechnung', 'application/pdf'), /Dateiendung/);
  });

  it('erkennt eine harmlose Doppelendung als solche, ohne sie zu verbieten', () => {
    // `.2024.pdf` ist keine Gefahr — aber die Mehrfachendung wird gemeldet.
    const befund = pruefeDateipolitik('rechnung.2024.pdf', 'application/pdf');
    assert.equal(befund.endung, 'pdf');
    assert.equal(befund.mehrfachEndung, true);
  });
});

describe('Dateipolitik — Hilfsfunktionen und Vollständigkeit', () => {
  it('zerlegt Namen in Endungen', () => {
    assert.deepEqual(endungen('a.b.c'), ['b', 'c']);
    assert.deepEqual(endungen('ohne'), []);
    assert.equal(letzteEndung('rechnung.pdf.exe'), 'exe');
    assert.equal(letzteEndung('ohne'), null);
  });

  it('entfernt Pfadanteile, bevor sie zur Endung werden', () => {
    assert.equal(letzteEndung('../../etc/passwd.pdf'), 'pdf');
    assert.equal(letzteEndung('C:\\temp\\x.png'), 'png');
  });

  /**
   * Die Gegenprobe: Jeder Typ, den ein Upload-Profil erlaubt, muss in der
   * Politik eine Endungsliste haben. Sonst käme ein Typ herein, den
   * `pruefeDateipolitik` nicht kennt — und der Fail-closed-Zweig wiese ihn
   * mit „nicht unterstützt" ab, obwohl das Profil ihn zulässt.
   */
  it('jeder erlaubte Typ hat eine Endungsliste', async () => {
    /**
     * `profiles.ts` trägt `server-only` und lässt sich hier nicht importieren
     * — zu Recht: Es zieht die Byteprüfung und damit die Signaturerkennung
     * nach sich. Die Typenliste steht dort aber als Literal, und genau die
     * wird gebraucht. Sie wird deshalb aus dem Quelltext gelesen, wie es
     * `auslieferung-absicherung.test.ts` mit dem Workflow tut.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const quelle = readFileSync(join(process.cwd(), 'src', 'lib', 'storage', 'profiles.ts'), 'utf8');

    const erlaubteTypen = new Set<string>();
    for (const liste of ['IMAGE_TYPES', 'DOCUMENT_TYPES']) {
      const block = quelle.match(new RegExp(`const ${liste} = \\[([\\s\\S]*?)\\];`));
      assert.ok(block, `${liste} muss in profiles.ts stehen`);
      for (const treffer of block[1].matchAll(/'([^']+)'/g)) erlaubteTypen.add(treffer[1]);
    }
    // Zusätzlich die Typen, die einzelne Profile direkt aufführen.
    const musterBlock = quelle.match(/UPLOAD_PROFILES = \{([\s\S]*?)\} as const;/);
    assert.ok(musterBlock, 'UPLOAD_PROFILES muss in profiles.ts stehen');
    for (const treffer of musterBlock[1].matchAll(/types: \[([^\]]*)\]/g)) {
      for (const t of treffer[1].matchAll(/'([^']+)'/g)) erlaubteTypen.add(t[1]);
    }

    assert.ok(erlaubteTypen.size >= 10, `zu wenige Typen gelesen: ${erlaubteTypen.size}`);
    for (const t of erlaubteTypen) {
      assert.ok(
        ENDUNGEN_JE_TYP[t],
        `Typ „${t}" ist erlaubt, hat aber keine Endungsliste in der Dateipolitik`,
      );
    }
  });

  it('die Archivgrenzen sind gesetzt und plausibel', () => {
    assert.ok(ARCHIV_GRENZEN.maxEntpacktBytes > ARCHIV_GRENZEN.maxKomprimiertBytes);
    assert.ok(ARCHIV_GRENZEN.maxVerhaeltnis >= 10);
    assert.ok(ARCHIV_GRENZEN.maxTiefe >= 1 && ARCHIV_GRENZEN.maxTiefe <= 10);
    assert.ok(ARCHIV_GRENZEN.maxEintraege > 0);
  });

  it('die Verbotsliste deckt die üblichen ausführbaren Endungen ab', () => {
    for (const e of ['exe', 'com', 'scr', 'msi', 'dll', 'jar', 'apk', 'bat', 'cmd', 'ps1']) {
      assert.ok(GEFAEHRLICHE_ENDUNGEN.has(e), `${e} fehlt in der Verbotsliste`);
    }
  });
});

// ===========================================================================
//  2) Der Prüfer
// ===========================================================================

describe('Testprüfer', () => {
  const scanner = testScanner();

  it('meldet harmlose Bytes als sauber', async () => {
    const befund = await scanner.scan(Buffer.from('%PDF-1.7\nharmlos'));
    assert.equal(befund.ergebnis, 'clean');
    assert.equal(befund.detectionName, undefined);
  });

  it('erkennt EICAR', async () => {
    const befund = await scanner.scan(eicarBytes());
    assert.equal(befund.ergebnis, 'infected');
    assert.match(befund.detectionName ?? '', /Eicar/i);
  });

  it('erkennt EICAR auch eingebettet', async () => {
    const eingebettet = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.from(EICAR, 'ascii'),
      Buffer.alloc(32, 0x20),
    ]);
    const befund = await scanner.scan(eingebettet);
    assert.equal(befund.ergebnis, 'infected');
  });

  it('gibt einen Fehler zurück, ohne ihn zu „sauber" zu machen', async () => {
    const befund = await scanner.scan(scanFehlerBytes());
    assert.equal(befund.ergebnis, 'error');
    assert.equal(befund.fehlerCode, 'UNAVAILABLE');
  });

  it('unterscheidet Zeitlimit von sonstigem Fehler', async () => {
    const befund = await scanner.scan(scanZeitlimitBytes());
    assert.equal(befund.ergebnis, 'error');
    assert.equal(befund.fehlerCode, 'TIMEOUT');
  });

  it('meldet Zustand und Fassung', async () => {
    assert.equal((await scanner.health()).erreichbar, true);
    assert.match((await scanner.version()) ?? '', /test-scanner/);
  });

  /**
   * Ein Prüfer, der immer „sauber" sagt, ist schlimmer als gar keiner — er
   * erzeugt genau die Zusicherung, die er nicht einlösen kann. Deshalb wirft
   * er beim **Erzeugen**, nicht beim ersten Scan: Der Fehler soll beim Start
   * auffallen, nicht bei der ersten hochgeladenen Datei.
   */
  it('verweigert den Dienst in einer echten Produktionsumgebung', async () => {
    /**
     * In einem **eigenen Prozess**, nicht durch Umbiegen von `process.env`
     * im laufenden: `NODE_ENV` lässt sich in Node 22 nicht mehr beliebig
     * überschreiben, und eine Prüfung, die das versucht, prüft am Ende die
     * Eigenheiten der Laufzeit statt den Wächter.
     *
     * Der Kindprozess bekommt genau die Umgebung, um die es geht:
     * Produktion, kein Testmarker, kein ClamAV. Er darf dann keinen Prüfer
     * bekommen — `getScanner()` gibt `null` zurück, und `testScanner()`
     * direkt aufgerufen wirft.
     */
    const { execFileSync } = await import('node:child_process');
    const skript = [
      "const { testScanner } = require('./src/lib/security/malware/test-scanner.ts');",
      'try { testScanner(); console.log("KEIN_FEHLER"); }',
      'catch (e) { console.log("GEWORFEN:" + String(e.message).slice(0, 60)); }',
    ].join('\n');

    const ausgabe = execFileSync(process.execPath, ['--import', 'tsx', '--eval', skript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        CLENARIS_TEST_CACHE_DIR: '',
        CLAMAV_HOST: '',
      },
    });

    assert.match(
      ausgabe,
      /GEWORFEN:.*Test-Schadsoftwareprüfer/,
      `der Wächter muss werfen — Ausgabe war: ${ausgabe.trim()}`,
    );
  });
});

// ===========================================================================
//  3) Die Auslieferungssperre
// ===========================================================================

describe('Auslieferungssperre — nur CLEAN geht raus', () => {
  const NICHT_AUSLIEFERBAR = ['PENDING', 'SCANNING', 'INFECTED', 'ERROR', 'QUARANTINED'];

  it('CLEAN wird ausgeliefert', () => {
    assert.equal(
      darfAusgeliefertWerden({ scanStatus: 'CLEAN', provenance: 'USER_UPLOAD' }).erlaubt,
      true,
    );
  });

  it('jeder andere Zustand einer Benutzerdatei wird gesperrt', () => {
    for (const status of NICHT_AUSLIEFERBAR) {
      const befund = darfAusgeliefertWerden({ scanStatus: status, provenance: 'USER_UPLOAD' });
      assert.equal(befund.erlaubt, false, `${status} darf nicht ausgeliefert werden`);
    }
  });

  /**
   * Servererzeugte Artefakte gehen nicht durch den Prüfer — ihre Bytes
   * entstehen im selben Prozess aus unseren eigenen Daten. Die Einstufung
   * steht in der Zeile, nicht in einer Annahme über Dateitypen.
   */
  it('servererzeugte Dateien gehen ohne Prüflauf raus', () => {
    for (const status of NICHT_AUSLIEFERBAR) {
      assert.equal(
        darfAusgeliefertWerden({ scanStatus: status, provenance: 'SYSTEM_GENERATED' }).erlaubt,
        true,
        `SYSTEM_GENERATED muss auch bei ${status} ausgeliefert werden`,
      );
      assert.equal(
        darfAusgeliefertWerden({ scanStatus: status, provenance: 'TRUSTED_IMPORT' }).erlaubt,
        true,
      );
    }
  });

  it('Altbestand ist standardmässig gesperrt', () => {
    const vorher = process.env.CLENARIS_LEGACY_FILES;
    try {
      delete process.env.CLENARIS_LEGACY_FILES;
      const befund = darfAusgeliefertWerden({
        scanStatus: 'PENDING',
        provenance: 'LEGACY_UNSCANNED',
      });
      assert.equal(befund.erlaubt, false);
      assert.equal(befund.grund, 'LEGACY_UNSCANNED');
    } finally {
      if (vorher !== undefined) process.env.CLENARIS_LEGACY_FILES = vorher;
    }
  });

  it('Altbestand lässt sich für den Übergang ausdrücklich öffnen', () => {
    const vorher = process.env.CLENARIS_LEGACY_FILES;
    try {
      process.env.CLENARIS_LEGACY_FILES = 'allow';
      const befund = darfAusgeliefertWerden({
        scanStatus: 'PENDING',
        provenance: 'LEGACY_UNSCANNED',
      });
      assert.equal(befund.erlaubt, true);
      assert.equal(befund.grund, 'LEGACY_ALLOWED', 'die Öffnung muss erkennbar bleiben');
    } finally {
      if (vorher === undefined) delete process.env.CLENARIS_LEGACY_FILES;
      else process.env.CLENARIS_LEGACY_FILES = vorher;
    }
  });

  it('ein beliebiger anderer Wert öffnet den Altbestand nicht', () => {
    const vorher = process.env.CLENARIS_LEGACY_FILES;
    try {
      for (const wert of ['true', '1', 'yes', 'ALLOW', '']) {
        process.env.CLENARIS_LEGACY_FILES = wert;
        assert.equal(
          darfAusgeliefertWerden({ scanStatus: 'PENDING', provenance: 'LEGACY_UNSCANNED' }).erlaubt,
          false,
          `„${wert}" darf nicht öffnen — nur genau „allow"`,
        );
      }
    } finally {
      if (vorher === undefined) delete process.env.CLENARIS_LEGACY_FILES;
      else process.env.CLENARIS_LEGACY_FILES = vorher;
    }
  });
});

// ===========================================================================
//  4) Der ganze Weg über HTTP
// ===========================================================================

type Zugaenge = Awaited<ReturnType<typeof loginAll>>;
let jars: Zugaenge;

interface Ticket {
  ticketId: string;
  signedUrl: string;
  path: string;
}
interface Abschluss {
  id: string;
  url: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

async function hochladen(opts: {
  jar: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  profile?: string;
}) {
  const ticket = await post<{ data: Ticket }>(
    '/api/files/upload-url',
    {
      profile: opts.profile ?? 'document',
      filename: opts.filename,
      mimeType: opts.mimeType,
      sizeBytes: opts.bytes.byteLength,
    },
    { jar: opts.jar },
  );
  if (ticket.status !== 201) return { ticket, upload: null, abschluss: null };

  const ziel = data(ticket);
  const pfad = `${BASE_URL}${new URL(ziel.signedUrl, BASE_URL).pathname}`;
  const upload = await fetch(pfad, {
    method: 'PUT',
    headers: { 'Content-Type': opts.mimeType },
    body: new Uint8Array(opts.bytes),
  });

  const abschluss = await post<{ data: Abschluss }>(
    '/api/files/finalize',
    { ticketId: ziel.ticketId, filename: opts.filename },
    { jar: opts.jar },
  );

  return { ticket, upload, abschluss, ticketId: ziel.ticketId };
}

describe('Upload über HTTP — Politik, Prüfer und Sperre hängen zusammen', () => {
  before(async () => {
    jars = await loginAll();
  });

  /**
   * Das Ticket darf keine Leseadresse enthalten.
   *
   * Der Befund, der diese Prüfung ausgelöst hat: `createSignedUpload` gab
   * neben der Schreibadresse eine `publicUrl` zurück, und
   * `POST /api/files/upload-url` reichte das Ticket unverändert an den Client
   * weiter. Beim Supabase-Treiber war das die öffentliche Objektadresse —
   * ein Zeiger auf Bytes, die noch nicht byteweise geprüft, nicht gegen die
   * Dateipolitik gehalten und nicht auf Schadsoftware untersucht sind, und zu
   * denen es noch gar kein `FileAsset` gibt, an dem sich eine Berechtigung
   * prüfen liesse.
   *
   * Geprüft wird die Antwort als Ganzes und nicht nur das eine Feld: Jede
   * Adresse, die nicht auf den eigenen Ursprung zeigt, wäre derselbe Umweg
   * unter anderem Namen.
   */
  it('das Upload-Ticket gibt keine Leseadresse heraus', async () => {
    const ticket = await post<{ data: Record<string, unknown> }>(
      '/api/files/upload-url',
      {
        profile: 'document',
        filename: 'ticket-pruefung.txt',
        mimeType: 'text/plain',
        sizeBytes: 12,
      },
      { jar: jars.admin },
    );
    assert.equal(ticket.status, 201);

    const ziel = data(ticket);
    assert.ok(!('publicUrl' in ziel), 'das Ticket darf kein Feld `publicUrl` tragen');

    /**
     * `signedUrl` ist die Ausnahme — sie ist die Schreibadresse und muss beim
     * externen Treiber auf dessen Ursprung zeigen. Alles andere nicht.
     */
    for (const [feld, wert] of Object.entries(ziel)) {
      if (feld === 'signedUrl' || typeof wert !== 'string') continue;
      assert.ok(
        !/^https?:\/\//i.test(wert),
        `\`${feld}\` darf keine absolute Adresse sein — sonst führt sie an der Freigabe vorbei`,
      );
      assert.ok(
        !/\/object\/public\//i.test(wert),
        `\`${feld}\` darf nicht auf eine öffentliche Ablageadresse zeigen`,
      );
    }
  });

  it('eine harmlose Datei wird angenommen und ist abrufbar', async () => {
    const bytes = Buffer.from('Ein harmloser Text für die Prüfreihe.\n', 'utf8');
    const { abschluss, ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'notiz.txt',
      mimeType: 'text/plain',
      bytes,
    });
    assert.equal(abschluss?.status, 201, 'der Abschluss muss gelingen');

    const abruf = await get(`/api/files/blob/${ticketId}`, { jar: jars.admin });
    assert.equal(abruf.status, 200, 'eine saubere Datei muss abrufbar sein');
  });

  /**
   * Der Kern dieser Wave: Die Datei wird **angenommen** — der Upload ist
   * abgeschlossen, die Bytes liegen fest, das `FileAsset` existiert. Und sie
   * ist trotzdem **nicht abrufbar**, weil der Prüfer etwas gefunden hat.
   *
   * Beides gehört zusammen: Ein Abbruch beim Abschluss liesse den Browser die
   * Datei erneut hochladen, und beim nächsten Versuch geschähe dasselbe. Der
   * Befund gehört an die Datei, nicht an die Antwort.
   */
  it('eine erkannte Datei wird angenommen, aber nicht ausgeliefert', async () => {
    const { abschluss, ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'test-eicar.txt',
      mimeType: 'text/plain',
      bytes: eicarBytes(),
    });
    assert.equal(abschluss?.status, 201, 'der Abschluss selbst gelingt');

    const abruf = await get(`/api/files/blob/${ticketId}`, { jar: jars.admin });
    assert.equal(abruf.status, 404, 'eine erkannte Datei darf nicht ausgeliefert werden');
  });

  /**
   * Die Sperre steht **neben** der Berechtigung, nicht in ihr: Auch die
   * Systemverantwortung bekommt die Datei nicht. Und die Antwort ist
   * dieselbe wie bei „gibt es nicht" — wer keinen Zugriff hat, soll nicht
   * erfahren, dass eine Datei in Quarantäne liegt.
   */
  it('auch die Systemverantwortung bekommt eine erkannte Datei nicht', async () => {
    const { ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'test-eicar-2.txt',
      mimeType: 'text/plain',
      bytes: eicarBytes(),
    });
    const abruf = await get(`/api/files/blob/${ticketId}`, { jar: jars.super });
    assert.equal(abruf.status, 404);
  });

  it('die Dateipolitik greift schon beim Abschluss', async () => {
    const bytes = Buffer.from('%PDF-1.7\nharmlos', 'latin1');
    const { abschluss } = await hochladen({
      jar: jars.admin,
      filename: 'rechnung.pdf.exe',
      mimeType: 'application/pdf',
      bytes,
    });
    assert.equal(
      abschluss?.status,
      400,
      'eine ausführbare Doppelendung muss abgewiesen werden',
    );
  });

  it('eine Endung, die nicht zum Inhalt passt, wird abgewiesen', async () => {
    const bytes = Buffer.from('%PDF-1.7\nharmlos', 'latin1');
    const { abschluss } = await hochladen({
      jar: jars.admin,
      filename: 'rechnung.jpg',
      mimeType: 'application/pdf',
      bytes,
    });
    assert.equal(abschluss?.status, 400);
  });

  /**
   * Gegenprobe zu Gate 2: Die dortige Byteprüfung darf durch Wave 2 nicht
   * schwächer geworden sein. HTML mit PDF-Typ muss weiterhin an der
   * Signaturprüfung scheitern — noch bevor die neue Politik greift.
   */
  it('die Byteprüfung aus Gate 2 greift unverändert', async () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1');
    const { abschluss, ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'boese.pdf',
      mimeType: 'application/pdf',
      bytes: html,
    });

    /**
     * Geprüft wird die **Wirkung**, nicht der genaue Code.
     *
     * HTML unter dem Namen einer PDF wird abgewiesen — aber je nachdem,
     * welche Schicht zuerst greift, mit 400 (`ValidationError` aus der
     * Byteprüfung beim Abschluss) oder 422 (`BusinessRuleError`, weil die
     * Bytes schon beim Schreiben verworfen wurden und beim Abschluss keine
     * Datei mehr vorliegt). Beides ist richtig; sich auf eines festzulegen
     * hiesse, die Reihenfolge der Schichten festzuschreiben.
     *
     * Was **nicht** verhandelbar ist: Es entsteht keine abrufbare Datei.
     */
    assert.ok(
      abschluss && abschluss.status >= 400 && abschluss.status < 500,
      `HTML als PDF muss abgewiesen werden, war ${abschluss?.status}`,
    );

    const abruf = await get(`/api/files/blob/${ticketId}`, { jar: jars.admin });
    assert.equal(abruf.status, 404, 'und es darf nichts abrufbar sein');
  });

  /**
   * Wiederholter Abschluss desselben Tickets darf keine zweite Datei
   * erzeugen — und auch keinen zweiten Prüflauf mit widersprüchlichem
   * Ergebnis. Der zweite Aufruf liefert dasselbe Asset zurück.
   */
  it('ein wiederholter Abschluss erzeugt keine zweite Datei', async () => {
    const bytes = Buffer.from('Wiederholter Abschluss.\n', 'utf8');
    const ticket = await post<{ data: Ticket }>(
      '/api/files/upload-url',
      { profile: 'document', filename: 'wdh.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength },
      { jar: jars.admin },
    );
    const ziel = data(ticket);
    const pfad = `${BASE_URL}${new URL(ziel.signedUrl, BASE_URL).pathname}`;
    await fetch(pfad, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(bytes),
    });

    const koerper = { ticketId: ziel.ticketId, filename: 'wdh.txt' };
    const erst = await post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin });
    const zweit = await post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin });

    assert.equal(erst.status, 201);
    assert.ok(zweit.status === 200 || zweit.status === 201);
    assert.equal(data(erst).id, data(zweit).id, 'dieselbe Datei, kein Doppel');
    assert.equal(data(erst).checksum, data(zweit).checksum);
  });

  /**
   * Drei gleichzeitige Abschlüsse: genau ein Asset, und der Prüflauf darf
   * keine widersprüchlichen Endzustände hinterlassen. Die Anspruchnahme in
   * `scanFileAsset` sorgt dafür, dass nur ein Lauf schreibt.
   */
  it('drei gleichzeitige Abschlüsse ergeben genau eine Datei', async () => {
    const bytes = Buffer.from('Gleichzeitig.\n', 'utf8');
    const ticket = await post<{ data: Ticket }>(
      '/api/files/upload-url',
      { profile: 'document', filename: 'par.txt', mimeType: 'text/plain', sizeBytes: bytes.byteLength },
      { jar: jars.admin },
    );
    const ziel = data(ticket);
    const pfad = `${BASE_URL}${new URL(ziel.signedUrl, BASE_URL).pathname}`;
    await fetch(pfad, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(bytes),
    });

    const koerper = { ticketId: ziel.ticketId, filename: 'par.txt' };
    const antworten = await Promise.all([
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
      post<{ data: Abschluss }>('/api/files/finalize', koerper, { jar: jars.admin }),
    ]);

    const ids = new Set(antworten.filter((a) => a.status < 300).map((a) => data(a).id));
    assert.equal(ids.size, 1, `genau eine Datei erwartet, waren ${ids.size}`);

    // Und sie ist danach in einem eindeutigen Zustand: abrufbar.
    const abruf = await get(`/api/files/blob/${ziel.ticketId}`, { jar: jars.admin });
    assert.equal(abruf.status, 200);
  });

  it('ohne Anmeldung öffnet die Kennung einer privaten Datei nichts', async () => {
    const bytes = Buffer.from('Privat.\n', 'utf8');
    const { ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'privat.txt',
      mimeType: 'text/plain',
      bytes,
    });
    const abruf = await get(`/api/files/blob/${ticketId}`);
    assert.equal(abruf.status, 404);
  });

  it('eine fremde Sitzung bekommt die Datei nicht', async () => {
    const bytes = Buffer.from('Nur für die Verwaltung.\n', 'utf8');
    const { ticketId } = await hochladen({
      jar: jars.admin,
      filename: 'intern.txt',
      mimeType: 'text/plain',
      bytes,
    });
    const abruf = await get(`/api/files/blob/${ticketId}`, { jar: jars.customer });
    assert.equal(abruf.status, 404);
  });
});
