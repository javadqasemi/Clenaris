import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Was am Auslieferungsweg nicht mehr verrutschen darf.
 *
 * **Warum das eine Testdatei ist und keine Zeile in der Anleitung.** Jeder
 * Punkt hier stand schon einmal in `docs/DEPLOYMENT.md` — und war trotzdem
 * falsch. Ein Rückfall auf `ssh-keyscan`, den die Anleitung als „empfohlen"
 * beschrieb. Ein `url: ${{ secrets.API_URL }}`, das die ganze Datei beim
 * Parsen ungültig machte, ohne dass es jemandem auffiel, weil ein Lauf mit
 * null Jobs nicht wie ein Fehler aussieht. Ein `DIRECT_URL`, das als
 * „empfohlen" geführt wurde und ohne das Prisma abbricht. Prosa hat diese
 * Fehler nicht verhindert; sie hat sie beschrieben.
 *
 * Diese Prüfungen lesen die Dateien und laufen in jedem Testlauf mit. Sie
 * brauchen weder Server noch Datenbank.
 *
 * Sie prüfen **Textgestalt**, nicht Verhalten — das ist ihre Grenze. Ein
 * Workflow, der diese Zeilen enthält, kann trotzdem anders scheitern. Aber
 * ein Workflow, der sie *nicht* enthält, scheitert nachweislich auf eine
 * Weise, die wir schon kennen.
 */

const wurzel = process.cwd();
const workflow = readFileSync(join(wurzel, '.github', 'workflows', 'deploy.yml'), 'utf8');

describe('Auslieferungs-Workflow — fail-closed', () => {
  /**
   * Der Anlass: Der Preflight fand `SERVER_USER` als einziges der
   * Verbindungs-Secrets ohne Prüfung. Fehlt es, setzt GitHub die Variable auf
   * den leeren String — `set -u` schlägt also nicht an —, und die Verbindung
   * geht als `@host` hinaus. Der Fehler kommt dann von der Gegenstelle und
   * zeigt aufs Netz statt auf die Konfiguration.
   */
  it('bricht ohne SERVER_USER ab, vor dem ersten SSH', () => {
    assert.match(
      workflow,
      /test -n "\$\{USER_NAME:-\}" \|\| \{/,
      'SERVER_USER muss wie SERVER_SSH_KEY und SERVER_HOST geprüft werden',
    );
    const stelleUser = workflow.indexOf('USER_NAME:-');
    const stelleSsh = workflow.indexOf('ssh -i ~/.ssh/id_deploy');
    assert.ok(stelleUser > 0 && stelleSsh > 0, 'beide Stellen müssen existieren');
    assert.ok(stelleUser < stelleSsh, 'die Prüfung muss vor dem ersten SSH-Aufruf stehen');
  });

  it('nimmt keinen Rückfall auf root an', () => {
    assert.doesNotMatch(
      workflow,
      /USER_NAME:-root|\$\{USER_NAME:=root\}/,
      'ein stiller Rückfall auf den mächtigsten Benutzer ist die falsche Antwort auf eine fehlende Angabe',
    );
  });

  /**
   * `schema.prisma` deklariert `directUrl = env("DIRECT_URL")`. Ohne die
   * Variable bricht Prisma mit P1012 ab, und ein leerer Wert zählt als
   * fehlend. Ohne diese Prüfung käme der Abbruch erst auf dem Server, mitten
   * in der Auslieferung.
   */
  it('bricht ohne DIRECT_URL ab', () => {
    assert.match(workflow, /test -n "\$\{DIRECT_URL:-\}" \|\| \{/);
    const schema = readFileSync(join(wurzel, 'prisma', 'schema.prisma'), 'utf8');
    assert.match(
      schema,
      /directUrl\s*=\s*env\("DIRECT_URL"\)/,
      'die Prüfung im Workflow hat nur solange einen Grund, wie das Schema die Variable verlangt',
    );
  });

  /**
   * Ein Tippfehler im Modus wirkt lautlos: `client-ip.ts` fällt bei jedem
   * unbekannten Wert auf `NONE` zurück. Im Anfragepfad ist das richtig —
   * beim Ausliefern wäre es eine Falle.
   */
  it('weist einen unbekannten TRUSTED_PROXY_MODE zurück, statt ihn stillschweigend zu verwerfen', () => {
    assert.match(workflow, /NONE\|SINGLE_REVERSE_PROXY\|CLOUDFLARE\)/);
    assert.match(workflow, /TRUSTED_PROXY_MODE hat den unbekannten Wert/);
  });

  it('verlangt den gepinnten Wirtsschlüssel und kennt keinen ssh-keyscan-Rückfall', () => {
    assert.match(workflow, /test -n "\$\{KNOWN_HOSTS:-\}" \|\| \{/);
    assert.doesNotMatch(
      workflow,
      /^\s*ssh-keyscan\s/m,
      'ssh-keyscan darf im Workflow nicht ausgeführt werden — es beantwortet nicht, ob der Gegenüber der richtige ist',
    );
    for (const treffer of workflow.matchAll(/StrictHostKeyChecking=(\w+)/g)) {
      assert.equal(treffer[1], 'yes', 'jede SSH-Verbindung prüft den Wirtsschlüssel');
    }
    assert.doesNotMatch(workflow, /UserKnownHostsFile=\/dev\/null/);
  });

  /**
   * Der `secrets`-Kontext ist unter `environment.url` unzulässig. GitHub
   * verwirft die Datei dann beim Parsen: Der Lauf entsteht und scheitert in
   * derselben Sekunde, mit null Jobs. Genau das ist hier einmal passiert und
   * monatelang unbemerkt geblieben.
   */
  it('verwendet den secrets-Kontext nicht unter environment.url', () => {
    const zeilen = workflow.split(/\r?\n/);
    const inUmgebung = zeilen.findIndex((z) => /^\s*environment:\s*$/.test(z));
    if (inUmgebung === -1) return; // kein environment-Block, nichts zu prüfen
    const block = zeilen.slice(inUmgebung, inUmgebung + 6).join('\n');
    assert.doesNotMatch(
      block,
      /^\s*url:.*secrets\./m,
      'environment.url mit secrets-Kontext macht die ganze Workflow-Datei ungültig',
    );
  });
});

describe('Client-Adresse — genau eine Richtlinie', () => {
  /**
   * Gate 4D.2. `session.ts` hatte eine eigene Kette
   * `cf-connecting-ip → x-real-ip → x-forwarded-for`, während `client-ip.ts`
   * dieselbe Kette längst durch `TRUSTED_PROXY_MODE` ersetzt hatte. Zwei
   * Auswertungen bedeuten zwei Sicherheitsniveaus, und das schwächere gewinnt
   * dort, wo niemand hinschaut.
   *
   * Die Werte landeten in `RefreshToken.ip` und `User.lastLoginIp` — den
   * Feldern, in die man bei einem Vorfall zuerst schaut.
   */
  it('liest die Proxy-Kopfzeilen nur in client-ip.ts', () => {
    const quellen = [
      join('src', 'lib', 'auth', 'session.ts'),
      join('src', 'server', 'services', 'auth.service.ts'),
      join('src', 'lib', 'rate-limit.ts'),
      join('src', 'lib', 'api', 'handler.ts'),
    ];
    const muster = /\.get\(\s*['"](?:cf-connecting-ip|x-real-ip|x-forwarded-for)['"]\s*\)/i;
    for (const rel of quellen) {
      const inhalt = readFileSync(join(wurzel, rel), 'utf8');
      assert.doesNotMatch(
        inhalt,
        muster,
        `${rel} darf die Adresse nicht selbst aus den Kopfzeilen lesen — das gehört in lib/http/client-ip.ts`,
      );
    }
  });

  it('client-ip.ts wertet jeden Kopf genau einmal aus', () => {
    const inhalt = readFileSync(join(wurzel, 'src', 'lib', 'http', 'client-ip.ts'), 'utf8');
    for (const kopf of ['cf-connecting-ip', 'x-real-ip']) {
      const treffer = inhalt.match(new RegExp(`\\.get\\('${kopf}'\\)`, 'g')) ?? [];
      assert.equal(treffer.length, 1, `${kopf} genau einmal`);
    }
    assert.doesNotMatch(
      inhalt,
      /\.get\('x-forwarded-for'\)/,
      'X-Forwarded-For ist seit Gate 4C keine Quelle mehr — auch nicht als Rückfall',
    );
  });
});

/**
 * Die Muster der Geheimnis-Suche.
 *
 * **Warum das hier steht und nicht in `ci-secret-scan.sh`.** Das Skript ist
 * bash; auf dem Entwicklungsrechner (Windows) läuft es gar nicht, und in der
 * Auslieferung läuft es genau einmal — dann, wenn ein Fehler am teuersten
 * ist. Die Muster selbst sind aber reine Zeichenkettenarbeit und lassen sich
 * ohne Server, ohne Datenbank und ohne bash prüfen.
 *
 * **Der Anlass.** Vom 2026-09-20 an scheiterte jeder Lauf an der
 * Geheimnis-Suche, und zwar an einem Fund, den es nicht gab: Das
 * Resend-Muster `re_[0-9A-Za-z_-]{24,}` hatte keine Tokengrenze und traf
 * damit `signatu`**`re_`**`quests_signedArtifactId_key` — einen SQL-Bezeichner
 * aus dem Signaturkern, rund sechshundertmal. Die Auslieferung stand fünf
 * Tage, und sie stand aus dem denkbar irreführendsten Grund: Die Prüfung
 * meldete ein Geheimnis im Repository.
 *
 * Diese Datei liest die Muster **aus dem Skript** statt sie zu wiederholen.
 * Eine Kopie wäre nach der ersten Änderung eine Lüge.
 */
describe('Geheimnis-Suche — Muster', () => {
  const skript = readFileSync(join(wurzel, 'scripts', 'ci-secret-scan.sh'), 'utf8');

  /**
   * Die Grenze steht im Skript als eigene Konstante, damit sie an einer
   * Stelle gepflegt wird. Hier wird sie genauso aufgelöst, wie bash es täte.
   */
  const grenze = skript.match(/^readonly TOKENGRENZE='(.+)'$/m)?.[1];

  const muster = (() => {
    const block = skript.match(/^muster=\(\r?\n([\s\S]*?)^\)\r?$/m)?.[1] ?? '';
    return block
      .split(/\r?\n/)
      .map((zeile) => zeile.trim())
      .filter(Boolean)
      .map((zeile) => {
        const roh = zeile.match(/^(['"])([\s\S]*)\1$/)?.[2];
        assert.ok(roh, `Eintrag nicht lesbar: ${zeile}`);
        const trenner = roh.indexOf('|');
        const name = roh.slice(0, trenner);
        const ere = roh.slice(trenner + 1).replaceAll('${TOKENGRENZE}', grenze ?? '');
        // `m`, weil `git grep` zeilenweise arbeitet: `^` heisst dort
        // Zeilenanfang, nicht Textanfang.
        return { name, ere, regex: new RegExp(ere, 'm') };
      });
  })();

  /**
   * Proben werden zur Laufzeit zusammengesetzt und stehen bewusst **nicht**
   * als fertige Zeichenkette im Quelltext.
   *
   * Der Grund ist derselbe Mechanismus, den diese Datei prüft: Die
   * Geheimnis-Suche liest den verfolgten Bestand, und dazu gehört diese
   * Datei. Ein vollständiges Token im Quelltext liesse die Auslieferung an
   * ihrer eigenen Prüfdatei scheitern — mit einer Meldung, die wie ein echter
   * Fund aussieht. Der Test ganz unten hält das fest.
   */
  const probe = (praefix: string, laenge: number, fuellung: string) =>
    praefix + fuellung.repeat(laenge);

  /** Je Muster ein synthetischer Wert, der die Form eines echten Schlüssels hat. */
  const musserkennen: Record<string, string> = {
    'Stripe (live)': probe('sk' + '_live_', 24, 'b'),
    'Stripe (test)': probe('sk' + '_test_', 24, 'b'),
    'Stripe Restricted': probe('rk' + '_live_', 24, 'b'),
    'Stripe Webhook': probe('whsec' + '_', 28, 'c'),
    'Google API': probe('AI' + 'za', 35, 'd'),
    Resend: probe('re' + '_', 30, 'a'),
    Anthropic: probe('sk-' + 'ant-', 30, 'e'),
    OpenAI: probe('sk-' + 'proj-', 30, 'e'),
    'Twilio Account SID': probe('A' + 'C', 32, 'f'),
    SendGrid: 'SG' + '.' + 'g'.repeat(22) + '.' + 'h'.repeat(22),
    'AWS Zugriffsschlüssel': probe('AK' + 'IA', 16, 'Z'),
    'Privater Schlüssel': '-----BEGIN ' + 'OPENSSH ' + 'PRIVATE KEY-----',
    'JSON Web Token': probe('eyJhbGciOi', 36, 'J'),
  };

  /**
   * Bezeichner aus dem Signaturkern — der tatsächliche Fehlalarm, wörtlich.
   * Dazu gewöhnliche Prisma- und Quelltextbezeichner derselben Bauart.
   */
  const darfnichterkennen = [
    'CREATE UNIQUE INDEX "signature_requests_signedArtifactId_key" ON "signature_requests"("signedArtifactId");',
    'CREATE INDEX "signature_requests_organizationId_createdAt_idx" ON "signature_requests"("organizationId", "createdAt");',
    'ALTER TABLE "signature_requests" ADD CONSTRAINT "signature_requests_genau_eine_quelle"',
    "  'signature_requests_offene_annahme_je_offerte',",
    'signature_requests_offene_abnahme_je_einsatz',
    'CREATE UNIQUE INDEX "signature_participants_requestId_order_key" ON "signature_participants"("requestId", "order");',
    'const massnahmeStatus = await prisma.measure_requests.findMany();',
    'export type FeatureRequestsAntwort = { scoreRequestsGesamt: number };',
  ];

  it('das Skript erklärt eine Tokengrenze und jedes Präfixmuster benutzt sie', () => {
    assert.ok(grenze, 'TOKENGRENZE muss im Skript als readonly-Konstante stehen');
    assert.ok(muster.length >= 13, `zu wenige Muster gelesen: ${muster.length}`);
    for (const { name, ere } of muster) {
      // Der private Schlüssel trägt seine Grenze im Muster selbst (`-----`).
      if (name === 'Privater Schlüssel') continue;
      assert.ok(
        ere.startsWith(grenze!),
        `Muster «${name}» beginnt ohne Tokengrenze — genau so entstand der Fehlalarm`,
      );
    }
  });

  it('jedes Muster hat eine Probe — ein neues Muster ohne Probe scheitert hier', () => {
    const namen = muster.map((m) => m.name).sort();
    const geprueft = Object.keys(musserkennen).sort();
    assert.deepEqual(
      namen,
      geprueft,
      'Muster und Proben müssen sich decken: ein ungeprüftes Muster ist ein unbelegtes Versprechen',
    );
  });

  it('erkennt einen synthetischen Schlüssel — am Zeilenanfang und eingebettet', () => {
    for (const { name, regex } of muster) {
      const wert = musserkennen[name]!;
      assert.ok(regex.test(wert), `«${name}» erkennt den Wert am Zeilenanfang nicht`);
      assert.ok(
        regex.test(`SOME_KEY="${wert}"`),
        `«${name}» erkennt den Wert hinter einem Gleichheitszeichen nicht`,
      );
      assert.ok(
        regex.test(`erste Zeile\nexport X=${wert}\nletzte Zeile`),
        `«${name}» erkennt den Wert nicht mitten im Text`,
      );
    }
  });

  it('schlägt bei keinem Bezeichner an — der behobene Fehlalarm', () => {
    for (const zeile of darfnichterkennen) {
      for (const { name, regex } of muster) {
        assert.ok(
          !regex.test(zeile),
          `«${name}» meldet einen Bezeichner als Schlüssel: ${zeile.slice(0, 70)}…`,
        );
      }
    }
  });

  /**
   * Die Gegenprobe an echten Dateien statt an Attrappen: Genau diese vier
   * haben den Lauf zum Scheitern gebracht. Ein Test gegen erfundene Zeilen
   * hätte den Fehler beschrieben; dieser hier hätte ihn gefunden.
   */
  it('meldet in den Dateien des Signaturkerns nichts', () => {
    const dateien = [
      join('prisma', 'migrations', '20260920100000_signatur_kern', 'migration.sql'),
      join('prisma', 'migrations', '20260920160000_offert_annahme_eindeutig', 'migration.sql'),
      join('prisma', 'migrations', '20260920190000_vor_ort_abnahme', 'migration.sql'),
      join('src', 'server', 'services', 'signature.service.ts'),
    ];
    for (const rel of dateien) {
      const inhalt = readFileSync(join(wurzel, rel), 'utf8');
      for (const { name, ere } of muster) {
        const treffer = inhalt.match(new RegExp(ere, 'gm')) ?? [];
        assert.equal(treffer.length, 0, `«${name}» meldet ${treffer.length} Fund(e) in ${rel}`);
      }
    }
  });

  // -------------------------------------------------------------------------
  //  Datenbank-Verbindungszeichenfolgen
  // -------------------------------------------------------------------------
  //
  // Der zweite Fehlalarm derselben Auslieferung, und er war schwerer zu
  // sehen als der erste: Seit `datenbanksicherung.test.ts` das Zerlegen einer
  // Verbindungszeichenfolge prüft — mit erfundenen Passwörtern gegen
  // `db.example.ch` —, meldete die Suche zwei Funde je Lauf. Ein Test, der
  // das Zerlegen prüft, kommt ohne eine Verbindung mit Passwort nicht aus.
  //
  // Die Ausnahme greift deshalb nicht am Passwort, sondern am **Wirt**:
  // Namen, die für Beispiele reserviert oder nicht auflösbar sind, können
  // keine Produktionszugangsdaten tragen.

  const dbMuster = skript.match(/^readonly DB_MUSTER='(.+)'$/m)?.[1];
  const dbAusnahme = skript.match(/^readonly DB_AUSNAHMEHOSTS='(.+)'$/m)?.[1];

  /** Genau die Verknüpfung, die das Skript aus `git grep` und `grep -v` bildet. */
  const alsFundGemeldet = (zeile: string) =>
    new RegExp(dbMuster!, 'm').test(zeile) && !new RegExp(dbAusnahme!, 'm').test(zeile);

  it('kennt Muster und Wirtsausnahme für Datenbankverbindungen', () => {
    assert.ok(dbMuster, 'DB_MUSTER muss als readonly-Konstante im Skript stehen');
    assert.ok(dbAusnahme, 'DB_AUSNAHMEHOSTS ebenso — sonst ist die Ausnahme nicht prüfbar');
  });

  it('meldet eine Verbindung zu einem echten Wirt', () => {
    const echt =
      'postgresql://nutzer:' + 'x'.repeat(14) + '@' + 'db.intern.beispielhoster.net' + ':5432/clenaris';
    assert.ok(alsFundGemeldet(echt), 'eine Produktionsverbindung muss weiterhin auffallen');
  });

  it('meldet Wegwerf- und Beispielwirte nicht', () => {
    const harmlos = [
      // Der CI-Dienstcontainer des eigenen Workflows.
      'postgresql://clenaris:' + 'clenaris' + '@' + 'localhost' + ':5432/clenaris_test',
      'postgresql://clenaris:' + 'clenaris' + '@' + '127.0.0.1' + ':5432/clenaris_test',
      // Die Fixtures aus datenbanksicherung.test.ts, wörtlich nachgebaut.
      "const v = verbindungAus('postgresql://max:" + 'geheim%2B17' + '@' + 'db.example.ch' + ":6543/clenaris?schema=public');",
      "const v = verbindungAus('postgresql://max:" + 'sehr-geheim' + '@' + 'db.example.ch' + ":6543/clenaris');",
    ];
    for (const zeile of harmlos) {
      assert.ok(!alsFundGemeldet(zeile), `als Fund gemeldet, ist aber keiner: ${zeile.slice(0, 80)}…`);
    }
  });

  /**
   * Wieder die Gegenprobe an den echten Dateien: Genau diese beiden haben den
   * Lauf zum Scheitern gebracht.
   */
  it('meldet in den Dateien, die den Lauf zum Scheitern brachten, nichts', () => {
    const dateien = [
      join('tests', 'api', 'datenbanksicherung.test.ts'),
      join('.github', 'workflows', 'deploy.yml'),
    ];
    for (const rel of dateien) {
      for (const zeile of readFileSync(join(wurzel, rel), 'utf8').split(/\r?\n/)) {
        assert.ok(!alsFundGemeldet(zeile), `${rel}: als Fund gemeldet — ${zeile.trim().slice(0, 80)}…`);
      }
    }
  });

  /**
   * Die Prüfdatei darf die Prüfung nicht selbst auslösen. Wer hier eine Probe
   * als fertige Zeichenkette hinschreibt, statt sie zusammenzusetzen, bricht
   * die Auslieferung — und der Fehler sieht aus wie ein echter Fund.
   */
  it('löst die Geheimnis-Suche nicht an sich selbst aus', () => {
    const selbst = readFileSync(
      join(wurzel, 'tests', 'api', 'auslieferung-absicherung.test.ts'),
      'utf8',
    );
    for (const { name, ere } of muster) {
      const treffer = selbst.match(new RegExp(ere, 'gm')) ?? [];
      assert.equal(
        treffer.length,
        0,
        `«${name}» schlägt in dieser Testdatei an — Probe zur Laufzeit zusammensetzen`,
      );
    }
    for (const zeile of selbst.split(/\r?\n/)) {
      assert.ok(
        !alsFundGemeldet(zeile),
        `diese Testdatei meldet sich selbst als Datenbankfund: ${zeile.trim().slice(0, 80)}…`,
      );
    }
  });
});
