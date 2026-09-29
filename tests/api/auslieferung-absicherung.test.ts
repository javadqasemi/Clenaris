import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANBIETERMUSTER,
  DB_AUSNAHMEHOSTS,
  DB_MUSTER,
  TOKENGRENZE,
  dateienPruefen,
  zeilenPruefen,
} from '../../scripts/security/geheimnisse';

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

describe('Aktionen auf Commits gepinnt — auch in den Vorlagen', () => {
  /**
   * Bis 2026-09-27 stand das nur im Bericht („alle vier Aktionen gepinnt"),
   * geprüft wurde es nicht — und die beiden V2-Vorlagen unter `deploy/v2/`
   * verwiesen auf bewegliche Tags (`@v4`). Eine Vorlage wird kopiert, wie sie
   * ist; mit Tag holte sie beim nächsten Tag der Aktion fremden Code in die
   * Pipeline mit Zugriff auf die Produktionsgeheimnisse.
   */
  it('jede `uses:`-Zeile nennt einen 40-stelligen Commit', () => {
    const dateien = [
      join('.github', 'workflows', 'deploy.yml'),
      join('deploy', 'v2', 'workflow-ergaenzung.yml'),
      join('deploy', 'v2', 'release-ausfuehrer.yml'),
    ];
    const lose: string[] = [];
    for (const datei of dateien) {
      for (const [nr, zeile] of readFileSync(join(wurzel, datei), 'utf8').split(/\r?\n/).entries()) {
        const treffer = /^\s*-?\s*uses:\s*(\S+)/.exec(zeile);
        if (treffer && !/@[0-9a-f]{40}$/.test(treffer[1]!)) lose.push(`${datei}:${nr + 1} ${treffer[1]}`);
      }
    }
    assert.deepEqual(lose, [], `nicht gepinnt:\n${lose.join('\n')}`);
  });
});

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
   * Notfallauftrag 2026-09-27, Phase 8. Bis dahin prüften zwei Fälle hier,
   * dass der Workflow `DIRECT_URL` und `TRUSTED_PROXY_MODE` vor dem Übertragen
   * in die Server-`.env` prüft. Die Übertragung selbst ist entfallen: Die
   * Pipeline kennt keine Anwendungsgeheimnisse mehr, sie liegen nur noch in
   * `shared/.env` auf dem Server. Dieselben Prüfungen macht jetzt
   * `scripts/production-preflight.ts` auf dem Server, gegen die Werte, die
   * die Anwendung wirklich liest (`produktions-vorpruefung.test.ts`). Hier
   * bleibt, was die Pipeline betrifft: dass sie sie nicht mehr anfasst.
   */
  it('der Auslieferungsauftrag liest keine Anwendungsgeheimnisse', () => {
    const auftrag = workflow.slice(workflow.indexOf('\n  auslieferung:'));
    assert.doesNotMatch(
      auftrag,
      /secrets\.(DATABASE_URL|DIRECT_URL|JWT_SECRET|CRON_SECRET|ENCRYPTION_KEY|STRIPE|RESEND|TWILIO|SUPABASE|ANTHROPIC)/,
      'jedes Geheimnis, das die Pipeline kennt, ist eines mehr, das nach einem Vorfall rotiert werden muss',
    );
  });

  it('baut nicht auf dem Server — er aktiviert das geprüfte Artefakt', () => {
    const auftrag = workflow.slice(workflow.indexOf('\n  auslieferung:'));
    const befehle = auftrag
      .split(/\r?\n/)
      .filter((z) => !/^\s*#/.test(z))
      .join('\n');
    assert.doesNotMatch(befehle, /scripts\/deploy\.sh|npm ci|npm install|npm run build|git (pull|reset|fetch)/);
    assert.match(befehle, /release-aktivieren\.sh/);
    assert.match(befehle, /sha256sum -c/, 'die Summe wird vor der Übertragung geprüft');
    const tor = workflow.slice(workflow.indexOf('\n  qualitaet:'), workflow.indexOf('\n  auslieferung:'));
    assert.match(tor, /scripts\/release-artefakt\.ts/, 'das Artefakt entsteht im Qualitätstor, aus dem geprüften Bau');
  });

  it('die Vorprüfung auf dem Server kennt DIRECT_URL, weil die Migrationen sie benutzen', () => {
    // Seit Prisma 7 (2026-09-29) steht die Adresse der Kommandozeile nicht mehr
    // im Schema (`directUrl`), sondern in `prisma.config.ts` — mit `DIRECT_URL`
    // zuerst, damit `migrate` am Pooler vorbeigeht.
    const konfiguration = readFileSync(join(wurzel, 'prisma.config.ts'), 'utf8');
    assert.match(konfiguration, /url:\s*process\.env\.DIRECT_URL\s*\|\|/);
    const vorpruefung = readFileSync(join(wurzel, 'scripts', 'production-preflight.ts'), 'utf8');
    assert.match(vorpruefung, /'DIRECT_URL'/);
    const aktivieren = readFileSync(join(wurzel, 'deploy', 'v2', 'release-aktivieren.sh'), 'utf8');
    assert.match(aktivieren, /production-preflight\.ts --phase vor-migration/, 'vor der Migration');
    const vor = aktivieren.indexOf('production-preflight.ts --phase vor-migration');
    const migration = aktivieren.indexOf('npx prisma migrate deploy');
    const umschalten = aktivieren.indexOf('umschalten "${ZIEL}"');
    assert.ok(vor > 0 && vor < migration && migration < umschalten, 'Vorprüfung → Migration → Umschalten');
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
  /**
   * Production V2. Bis hierher prüfte der Workflow nur `main` — also erst,
   * nachdem der Fehler im ausgelieferten Zweig stand.
   */
  it('prüft Pull Requests gegen main', () => {
    assert.match(
      workflow,
      /^\s*pull_request:\s*\n\s*branches:\s*\[main\]\s*$/m,
      'ohne pull_request-Auslöser wird erst nach dem Zusammenführen geprüft',
    );
  });

  /**
   * `pull_request_target` führt den Workflow im Kontext des Zielzweigs aus
   * **und** stellt dabei die Secrets bereit, während der geprüfte Code aus
   * dem Pull Request stammt. Wer einen Fork öffnen darf, bekäme damit die
   * Produktions-Secrets.
   */
  it('benutzt kein pull_request_target', () => {
    // Geprüft wird der **Auslöser**, nicht das Wort: Der Kommentar im
    // Workflow nennt `pull_request_target` ausdrücklich, um zu begründen,
    // warum es dort nicht steht. Eine Prüfung, die eine Begründung verbietet,
    // erzwingt schweigende Entscheidungen.
    assert.doesNotMatch(
      workflow,
      /^\s{0,4}pull_request_target:/m,
      'pull_request_target stellt Secrets bereit, während es fremden Code ausführt',
    );
  });

  /**
   * Der Kern der Trennung: Ein Pull Request ist eine Frage, keine
   * Entscheidung. Er löst das volle Qualitätstor aus und nichts sonst.
   */
  it('liefert aus einem Pull Request niemals aus', () => {
    const auftrag = workflow.slice(workflow.indexOf('\n  auslieferung:'));
    assert.match(
      auftrag,
      /github\.event_name != 'pull_request'/,
      'der Auslieferungsauftrag muss Pull Requests ausdrücklich ausschliessen',
    );
    assert.match(auftrag, /needs:\s*qualitaet/, 'und erst nach dem Qualitätstor laufen');
  });

  /**
   * Fail-closed: Ist `DEPLOY_ENABLED` nicht gesetzt, liefert GitHub den
   * leeren String und der Auftrag wird übersprungen. Solange für Production
   * V2 kein Server steht, darf ein grüner Lauf auf `main` keine Auslieferung
   * an das alte Ziel auslösen.
   */
  it('liefert nur bei ausdrücklich eingeschalteter Auslieferung aus', () => {
    const auftrag = workflow.slice(workflow.indexOf('\n  auslieferung:'));
    assert.match(
      auftrag,
      /vars\.DEPLOY_ENABLED == 'true'/,
      'ohne diesen Schalter liefert der nächste grüne Lauf an das Ziel der bestehenden Secrets',
    );
  });

  /**
   * Das Qualitätstor läuft auch für Pull Requests aus Forks. Dort stellt
   * GitHub keine Secrets bereit — ein Auftrag, der welche läse, schlüge
   * genau dann fehl, wenn er gebraucht wird. Er kommt deshalb vollständig
   * mit Wegwerfwerten aus.
   */
  it('das Qualitätstor liest kein einziges Secret', () => {
    const anfang = workflow.indexOf('\n  qualitaet:');
    const ende = workflow.indexOf('\n  auslieferung:');
    assert.ok(anfang > 0 && ende > anfang, 'beide Aufträge müssen existieren');
    const tor = workflow.slice(anfang, ende);
    assert.doesNotMatch(
      tor,
      /secrets\./,
      'ein Qualitätstor mit Secrets ist für Fork-Pull-Requests nicht lauffähig',
    );
  });

  /**
   * Die öffentliche Adresse ist Konfiguration. In der Zusammenfassung — einer
   * reinen Anzeigefläche — hat der `secrets`-Kontext nichts zu suchen.
   */
  it('schreibt keinen secrets-Wert in die Zusammenfassung', () => {
    const stelle = workflow.indexOf('GITHUB_STEP_SUMMARY');
    assert.ok(stelle > 0, 'die Zusammenfassung muss existieren');
    const block = workflow.slice(workflow.lastIndexOf('- name: Zusammenfassung'), stelle);
    assert.doesNotMatch(
      block,
      /secrets\./,
      'die Regel «Secrets stehen in keiner Ausgabe» verliert ihren Wert mit der ersten Ausnahme',
    );
  });

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
 * Diese Datei liest die Muster **aus der Prüfung selbst** statt sie zu
 * wiederholen. Eine Kopie wäre nach der ersten Änderung eine Lüge. Seit
 * 2026-09-27 stehen sie in `scripts/security/geheimnisse.ts` (das Bash-Skript
 * ist nur noch eine Hülle darum) und werden hier importiert statt aus einem
 * Skripttext herausgelesen.
 */
describe('Geheimnis-Suche — Muster', () => {
  const grenze = TOKENGRENZE;

  // `m`, weil die Prüfung zeilenweise arbeitet: `^` heisst Zeilenanfang.
  const muster = ANBIETERMUSTER.map(({ name, muster: m }) => ({ name, ere: m.source, regex: new RegExp(m.source, 'm') }));

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

  it('die Prüfung erklärt eine Tokengrenze und jedes Präfixmuster benutzt sie', () => {
    assert.ok(grenze, 'TOKENGRENZE muss in scripts/security/geheimnisse.ts exportiert sein');
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

  /** Genau die Regel der Prüfung — über ihren Zeilenkern, nicht nachgebaut. */
  const alsFundGemeldet = (zeile: string) =>
    zeilenPruefen('beliebig.ts', zeile).some((f) => f.regel === 'Datenbankverbindung mit Passwort');

  it('kennt Muster und Wirtsausnahme für Datenbankverbindungen', () => {
    assert.ok(DB_MUSTER instanceof RegExp, 'DB_MUSTER muss exportiert sein');
    assert.ok(DB_AUSNAHMEHOSTS instanceof RegExp, 'DB_AUSNAHMEHOSTS ebenso — sonst ist die Ausnahme nicht prüfbar');
  });

  it('meldet verfolgte Umgebungsdateien, lässt die Beispiele durch', () => {
    const funde = dateienPruefen(['.env', '.env.staging', 'x/.env.local', '.env.example', 'ops/.env.monitor.example'], () => null, '.env\n');
    assert.deepEqual(funde.map((f) => f.datei).sort(), ['.env', '.env.staging', 'x/.env.local']);
    assert.ok(dateienPruefen([], () => null, 'node_modules/\n').some((f) => f.datei === '.gitignore'), '.gitignore ohne .env ist ein Fund');
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
