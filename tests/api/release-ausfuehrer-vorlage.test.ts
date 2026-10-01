import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { releaseUebernahmeSchema } from '../../src/lib/validation/system';

/**
 * Beide Wege in die Produktion — ein Vertrag (2026-09-30).
 *
 * Es gibt zwei Wege, eine Fassung auf den Server zu bringen, und beide
 * bleiben: den direkten Auftrag `auslieferung` in `.github/workflows/deploy.yml`
 * und den Release-Ausführer (`deploy/v2/release-ausfuehrer.yml`), der Termine
 * aus dem Release Center abarbeitet. Die Vorlage des Ausführers war bis
 * hierher eine eigene, ungeprüfte Beschreibung — und hätte beim ersten Lauf
 * versagt: andere Secret-Namen als `deploy.yml`, kein Port, kein `BatchMode`,
 * das Aktivierungsskript aus `current/` statt aus dem Archiv, Ausdrücke im
 * Skripttext, und „ROLLED_BACK", sobald eine zweite Frage an die Instanz
 * zufällig die alte Version lieferte.
 *
 * **Warum Textprüfungen.** Eine Vorlage läuft nirgends, bevor sie eingeschaltet
 * wird — und dann gegen die Produktion. Was man vorher prüfen kann, ist ihre
 * Gestalt, und genau darin lagen die Fehler. Die Prüfungen lesen die Dateien
 * und brauchen weder Server noch Datenbank noch Bash. Sie beweisen nicht, dass
 * ein Lauf gelingt (dafür bleibt der Probeserver, V2-3); sie beweisen, dass er
 * nicht an einem der bekannten Fehler scheitert.
 *
 * Das Verhalten des Umschaltens selbst prüft `release-ruecksprung.test.ts`
 * mit Attrappen — hier steht, dass beide Wege es auf dieselbe Weise aufrufen.
 */

const WURZEL = join(__dirname, '..', '..');
const lesen = (...teile: string[]) => readFileSync(join(WURZEL, ...teile), 'utf8');

const DEPLOY = join('.github', 'workflows', 'deploy.yml');
const VORLAGE = join('deploy', 'v2', 'release-ausfuehrer.yml');

const deployYml = lesen(DEPLOY);
const vorlage = lesen(VORLAGE);
const aktivieren = lesen('deploy', 'v2', 'release-aktivieren.sh');
const ruecksprungSh = lesen('deploy', 'v2', 'release-ruecksprung.sh');

/** Jede Workflow-Datei und jede Vorlage — auch eine, die morgen dazukommt. */
function workflowDateien(): string[] {
  const dateien: string[] = [];
  for (const ordner of [join('.github', 'workflows'), join('deploy', 'v2')]) {
    for (const name of readdirSync(join(WURZEL, ordner))) {
      if (/\.ya?ml$/.test(name)) dateien.push(join(ordner, name));
    }
  }
  return dateien.sort();
}

// ---------------------------------------------------------------------------
//  Werkzeuge zum Lesen von YAML als Text
// ---------------------------------------------------------------------------

interface Skriptblock {
  zeile: number;
  inhalt: string;
}

/**
 * Den Inhalt jedes `run:` finden — einzeilig, `|`, `|-`, `>`, `>-` oder als
 * mehrzeiliger schlichter Wert.
 *
 * Über die Einrückung, wie YAML selbst: Zum Wert gehört jede folgende Zeile,
 * die tiefer eingerückt ist als der Schlüssel `run`, und jede Leerzeile
 * dazwischen. Eine Suche nach „der Zeile nach `run: |`" allein übersähe den
 * Ausdruck in Zeile zwanzig eines Skripts — und gerade dort stand er in der
 * alten Vorlage. Kommentarzeilen im Skript gehören dazu: GitHub setzt
 * Ausdrücke **vor** der Shell ein, auch in einem Shell-Kommentar.
 */
function skriptbloecke(text: string): Skriptblock[] {
  const zeilen = text.split(/\r?\n/);
  const bloecke: Skriptblock[] = [];
  for (let i = 0; i < zeilen.length; i++) {
    const treffer = /^(\s*)(-\s+)?run:(.*)$/.exec(zeilen[i]!);
    if (!treffer) continue;
    const spalte = treffer[1]!.length + (treffer[2]?.length ?? 0);
    const teile = [treffer[3]!];
    for (let j = i + 1; j < zeilen.length; j++) {
      const z = zeilen[j]!;
      if (z.trim() === '') {
        teile.push('');
        continue;
      }
      if (z.length - z.trimStart().length <= spalte) break;
      teile.push(z);
    }
    bloecke.push({ zeile: i + 1, inhalt: teile.join('\n') });
  }
  return bloecke;
}

/** Ein Auftrag unter `jobs:` — von seinem Namen bis zum nächsten Auftrag. */
function auftrag(text: string, name: string): string {
  const zeilen = text.split(/\r?\n/);
  const anfang = zeilen.indexOf(`  ${name}:`);
  assert.ok(anfang >= 0, `Auftrag ${name} fehlt`);
  let ende = zeilen.length;
  for (let i = anfang + 1; i < zeilen.length; i++) {
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(zeilen[i]!)) {
      ende = i;
      break;
    }
  }
  return zeilen.slice(anfang, ende).join('\n');
}

/** Die Schritte eines Auftrags, je mit Namen und Text. */
function schritte(auftragText: string): { name: string; text: string }[] {
  const liste: { name: string; text: string }[] = [];
  let aktuell: string[] | null = null;
  for (const zeile of auftragText.split(/\r?\n/)) {
    if (/^ {6}- /.test(zeile)) {
      if (aktuell) liste.push({ name: /name:\s*(.+)/.exec(aktuell.join('\n'))?.[1]?.trim() ?? '', text: aktuell.join('\n') });
      aktuell = [zeile];
    } else if (aktuell) {
      if (/^ {0,4}\S/.test(zeile)) {
        liste.push({ name: /name:\s*(.+)/.exec(aktuell.join('\n'))?.[1]?.trim() ?? '', text: aktuell.join('\n') });
        aktuell = null;
      } else aktuell.push(zeile);
    }
  }
  if (aktuell) liste.push({ name: /name:\s*(.+)/.exec(aktuell.join('\n'))?.[1]?.trim() ?? '', text: aktuell.join('\n') });
  return liste;
}

function schritt(auftragText: string, name: string): string {
  const s = schritte(auftragText).find((x) => x.name === name);
  assert.ok(s, `Schritt „${name}" fehlt`);
  return s.text;
}

/** Zeilen ohne YAML- und Shell-Kommentare — geprüft wird, was ausgeführt wird. */
function ohneKommentare(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((z) => !/^\s*#/.test(z))
    .join('\n');
}

/** ssh- und scp-Aufrufe aus den Skriptblöcken, Fortsetzungszeilen zusammengefügt. */
function verbindungen(text: string): string[] {
  const aufrufe: string[] = [];
  for (const block of skriptbloecke(text)) {
    const logisch = block.inhalt.replace(/\\\r?\n\s*/g, ' ');
    for (const zeile of logisch.split(/\r?\n/)) {
      const t = zeile.trim();
      if (/^(ssh|scp)\s/.test(t)) aufrufe.push(t);
    }
  }
  return aufrufe;
}

const auslieferung = auftrag(deployYml, 'auslieferung');
const ausfuehren = auftrag(vorlage, 'ausfuehren');
const WEGE = [
  { name: 'deploy.yml (Auftrag auslieferung)', text: auslieferung, summe: 'steps.beilage.outputs.sha256', archiv: 'steps.beilage.outputs.archiv' },
  { name: 'release-ausfuehrer.yml', text: ausfuehren, summe: 'steps.abholen.outputs.sha256', archiv: 'steps.abholen.outputs.archiv' },
] as const;

// ---------------------------------------------------------------------------

describe('Workflows und Vorlagen — keine Ausdrücke im Skripttext', () => {
  it('der Detektor findet Ausdrücke in jeder Blockform', () => {
    const probe = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: echo "${{ github.sha }}"',
      '      - name: zwei',
      '        run: |',
      '          echo eins',
      '',
      '          # auch im Kommentar: ${{ github.actor }}',
      '      - name: drei',
      '        run: >-',
      '          echo',
      "          '${{ steps.x.outputs.y }}'",
      '        env:',
      '          SAUBER: ${{ github.sha }}',
      '      - name: vier',
      "        run: 'echo ohne'",
    ].join('\n');
    const bloecke = skriptbloecke(probe);
    assert.equal(bloecke.length, 4);
    assert.deepEqual(
      bloecke.map((b) => b.inhalt.includes('${{')),
      [true, true, true, false],
      'jede Form wird bis zum Ende gelesen — und `env:` gehört nicht mehr dazu',
    );
  });

  it('kein Ausdruck in einem run:-Block — in keinem Workflow und keiner Vorlage', () => {
    const dateien = workflowDateien();
    assert.ok(dateien.includes(DEPLOY) && dateien.includes(VORLAGE), `gefunden: ${dateien.join(', ')}`);
    const funde: string[] = [];
    for (const datei of dateien) {
      const bloecke = skriptbloecke(lesen(datei));
      assert.ok(bloecke.length > 0, `${datei}: keine run:-Blöcke gefunden — der Detektor liest die Datei nicht`);
      for (const b of bloecke) {
        if (b.inhalt.includes('${{')) funde.push(`${datei}:${b.zeile}`);
      }
    }
    assert.deepEqual(funde, [], `Ausdrücke im Skripttext (Werte gehören in env:):\n${funde.join('\n')}`);
  });
});

describe('Release-Ausführer (Vorlage) — fail-closed und mit den Namen von deploy.yml', () => {
  const SSH_SECRETS = ['APP_DIRECTORY', 'SERVER_HOST', 'SERVER_PORT', 'SERVER_SSH_KEY', 'SERVER_SSH_KNOWN_HOSTS', 'SERVER_USER'];
  const secretsIn = (text: string) => [...new Set([...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((t) => t[1]!))].sort();

  it('liest genau die dokumentierten Secrets und Variablen', () => {
    assert.deepEqual(
      secretsIn(ohneKommentare(vorlage)),
      [...SSH_SECRETS, 'RELEASE_EXECUTOR_SIGNING_KEY', 'RELEASE_EXECUTOR_TOKEN'].sort(),
    );
    const variablen = [...new Set([...ohneKommentare(vorlage).matchAll(/vars\.([A-Z0-9_]+)/g)].map((t) => t[1]!))].sort();
    assert.deepEqual(variablen, ['CLENARIS_URL', 'RELEASE_EXECUTOR_ENABLED']);
  });

  it('deploy.yml liefert mit denselben Secret-Namen aus', () => {
    const genutzt = secretsIn(ohneKommentare(auslieferung));
    for (const name of SSH_SECRETS) assert.ok(genutzt.includes(name), `deploy.yml liest ${name} nicht`);
    assert.deepEqual(
      genutzt.filter((n) => !SSH_SECRETS.includes(n)),
      ['API_URL'],
      'ausser dem Übergangs-Rückfall API_URL keine weiteren Secrets im Auslieferungsauftrag',
    );
  });

  it('läuft nur nach Zeitplan oder von Hand, und nur mit RELEASE_EXECUTOR_ENABLED', () => {
    const ausloeser = /^on:\s*\n((?:[ \t]+.*\n|\s*\n)+)/m.exec(vorlage)?.[1] ?? '';
    const schluessel = [...ausloeser.matchAll(/^ {2}([a-z_]+):/gm)].map((t) => t[1]).sort();
    assert.deepEqual(schluessel, ['schedule', 'workflow_dispatch'], 'kein push, kein pull_request, kein pull_request_target');
    assert.doesNotMatch(vorlage, /^\s{0,4}(push|pull_request|pull_request_target):/m);
    assert.match(ausfuehren, /^ {4}if: vars\.RELEASE_EXECUTOR_ENABLED == 'true'\s*$/m);
    assert.match(ausfuehren, /^ {4}environment: production\s*$/m);
  });

  it('checkt überall ohne gespeicherte Zugangsdaten aus', () => {
    for (const datei of workflowDateien()) {
      const text = lesen(datei);
      const auschecken = [...text.matchAll(/uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n((?:\s{8,}.*\n)*)/g)];
      for (const t of auschecken) {
        assert.match(t[1]!, /persist-credentials: false/, `${datei}: actions/checkout ohne persist-credentials: false`);
      }
    }
    assert.ok(/actions\/checkout@/.test(vorlage), 'die Vorlage checkt aus');
  });

  it('der Ausführungsschlüssel erfüllt das Schema der Schnittstelle', () => {
    const zeile = /^\s+SCHLUESSEL:\s*(.+)$/m.exec(ausfuehren)?.[1]?.trim();
    assert.equal(zeile, 'github-actions-lauf-${{ github.run_id }}');
    const schema = releaseUebernahmeSchema.shape.ausfuehrungsSchluessel;
    // Eine Lauf-ID hat heute elf Stellen; geprüft wird dieselbe Form, die
    // `abholen` und `melden` an die Schnittstelle schicken.
    for (const laufId of ['12345678901', '1', '9'.repeat(20)]) {
      const schluessel = zeile.replace('${{ github.run_id }}', laufId);
      assert.ok(schema.safeParse(schluessel).success, `abgewiesen: ${schluessel}`);
      assert.match(schluessel, /^[A-Za-z0-9._:-]{16,120}$/);
    }
  });

  it('CI-Nachweis nur aus einem grünen Push-Lauf von deploy.yml auf main', () => {
    const befehl = skriptbloecke(ausfuehren)
      .map((b) => b.inhalt.replace(/\\\r?\n\s*/g, ' '))
      .join('\n')
      .split(/\r?\n/)
      .find((z) => /gh run list/.test(z));
    assert.ok(befehl, 'gh run list fehlt');
    for (const teil of ['--workflow deploy.yml', '--branch main', '--event push', '--commit "$COMMIT"', '--status success']) {
      assert.ok(befehl.includes(teil), `gh run list ohne ${teil}`);
    }
    assert.match(befehl, /--json databaseId,url,headSha,headBranch,event,conclusion,status/);
    assert.match(ausfuehren, /release-ausfuehrer\.ts ci-lauf --datei laeufe\.json --commit "\$COMMIT"/);
    assert.match(ausfuehren, /gh run download "\$CI_ID" --name "release-\$COMMIT" --dir release/);
  });

  it('ROLLED_BACK folgt allein dem Ausgang der Aktivierung', () => {
    const ausgefuehrt = ohneKommentare(vorlage);
    assert.doesNotMatch(ausgefuehrt, /ROLLED_BACK|SUCCEEDED|--ergebnis|laufende-version/, 'kein Ergebnis wird im Workflow errechnet');
    const melden = schritt(ausfuehren, 'Ergebnis melden');
    assert.match(melden, /release-ausfuehrer\.ts melden --auftrag "\$AUFTRAG" --aktivierung "\$CODE"/);
    assert.match(melden, /CODE: \$\{\{ steps\.aktivieren\.outputs\.code \}\}/);
    const aktivierung = schritt(ausfuehren, 'Übertragen und aktivieren');
    assert.match(aktivierung, /set \+e[\s\S]*code=\$\?[\s\S]*echo "code=\$\{code\}" >> "\$GITHUB_OUTPUT"/);
  });

  /**
   * „Übernommen" heisst: `abholen` hat seine Ausgaben geschrieben — das tut
   * es erst nach der bestätigten Übernahme (Vertrag C4: archiv, sha256,
   * buildid). Eine Bedingung auf eine Ausgabe, die `abholen` gar nicht
   * schreibt, wäre nie erfüllt, und kein Auftrag würde je gemeldet.
   */
  it('meldet auch nach einem Fehlschlag, sobald der Auftrag übernommen ist', () => {
    const melden = schritt(ausfuehren, 'Ergebnis melden');
    assert.match(melden, /if: always\(\) && steps\.abholen\.outputs\.archiv != ''/);
    assert.match(melden, /AUFTRAG: \$\{\{ steps\.plan\.outputs\.auftrag \}\}/);
    const abholen = schritt(ausfuehren, 'Messen und übernehmen');
    assert.match(abholen, /^\s+id: abholen\s*$/m);
    assert.match(abholen, /--auftrag "\$AUFTRAG"/);
    assert.match(abholen, /AUFTRAG: \$\{\{ steps\.plan\.outputs\.auftrag \}\}/, 'übernommen wird genau der geplante Auftrag');
    const reihenfolge = schritte(ausfuehren).map((s) => s.name);
    assert.ok(reihenfolge.indexOf('Ergebnis melden') > reihenfolge.indexOf('Übertragen und aktivieren'));
  });

  it('Befehle des Werkzeugs in der Reihenfolge des Vertrags', () => {
    const text = ohneKommentare(ausfuehren);
    const stellen = ['release-ausfuehrer.ts plan', 'gh run list', 'ci-lauf', 'gh run download', 'release-ausfuehrer.ts abholen', 'release-aktivieren.sh', 'release-ausfuehrer.ts melden'].map((t) =>
      text.indexOf(t),
    );
    assert.ok(stellen.every((s) => s > 0), `fehlt: ${stellen.join(', ')}`);
    assert.deepEqual([...stellen].sort((a, b) => a - b), stellen, 'plan → CI-Lauf → Download → abholen → aktivieren → melden');
  });
});

describe('Beide Wege — ein Aktivierungsvertrag (C3)', () => {
  for (const weg of WEGE) {
    describe(weg.name, () => {
      const ausgefuehrt = ohneKommentare(weg.text);

      it('Aktivierungsskript aus dem geprüften Archiv, nie aus current/', () => {
        assert.match(ausgefuehrt, /tar -xzOf "\$\{?ARCHIV\}?" deploy\/v2\/release-aktivieren\.sh > aktivierung\/release-aktivieren\.sh/);
        assert.doesNotMatch(ausgefuehrt, /current\//, 'nichts aus dem laufenden Release');
        assert.match(ausgefuehrt, new RegExp(`ARCHIV: \\$\\{\\{ ${weg.archiv.replace(/\./g, '\\.')} \\}\\}`));
      });

      it('ruft mit --erwartet-sha256 der gemessenen Summe auf, CLENARIS_BASIS aus APP_DIRECTORY', () => {
        assert.match(ausgefuehrt, new RegExp(`SUMME: \\$\\{\\{ ${weg.summe.replace(/\./g, '\\.')} \\}\\}`));
        assert.match(
          ausgefuehrt,
          /printf 'CLENARIS_BASIS=%q bash %q %q --erwartet-sha256 %q' \\\s*\n\s*"\$\{APP_DIRECTORY\}" "\$\{eingang\}\/release-aktivieren\.sh" "\$\{eingang\}\/\$\(basename "\$\{?ARCHIV\}?"\)" "\$\{SUMME\}"/,
        );
        assert.match(ausgefuehrt, /eingang="\$\{APP_DIRECTORY%\/\}\/releases-eingang"/);
      });

      it('legt den Eingang an, bevor übertragen wird', () => {
        const anlegen = ausgefuehrt.indexOf("printf 'mkdir -p -- %q' \"${eingang}\"");
        const uebertragen = ausgefuehrt.indexOf('scp ');
        assert.ok(anlegen > 0 && uebertragen > anlegen, 'mkdir -p des Eingangs vor scp');
      });

      it('jede ssh/scp-Verbindung mit Port, BatchMode, ConnectTimeout und StrictHostKeyChecking=yes', () => {
        const aufrufe = verbindungen(weg.text);
        assert.ok(aufrufe.length >= 3, `zu wenige Verbindungen gefunden: ${aufrufe.length}`);
        for (const a of aufrufe) {
          assert.match(a, a.startsWith('scp') ? /\s-P "\$\{port\}"/ : /\s-p "\$\{port\}"/, `ohne Port: ${a}`);
          assert.match(a, /-o BatchMode=yes/, `ohne BatchMode: ${a}`);
          assert.match(a, /-o ConnectTimeout=\d+/, `ohne ConnectTimeout: ${a}`);
          assert.match(a, /-o StrictHostKeyChecking=yes/, `ohne Wirtsschlüsselprüfung: ${a}`);
          assert.match(a, /-i ~\/\.ssh\/id_deploy/, `ohne den vorbereiteten Schlüssel: ${a}`);
        }
        assert.doesNotMatch(weg.text, /StrictHostKeyChecking=(no|accept-new|ask)|UserKnownHostsFile=\/dev\/null/);
      });

      it('bricht ohne SERVER_USER vor der ersten Verbindung ab — kein Rückfall auf root', () => {
        const pruefung = ausgefuehrt.indexOf('test -n "${USER_NAME:-}" ||');
        const ersteVerbindung = ausgefuehrt.search(/^\s*(ssh|scp) /m);
        assert.ok(pruefung > 0 && ersteVerbindung > pruefung, 'die Prüfung steht vor dem ersten ssh/scp');
        assert.doesNotMatch(weg.text, /USER_NAME:-root|USER_NAME:=root/);
      });

      it('verlangt den gepinnten Wirtsschlüssel, ohne ssh-keyscan', () => {
        assert.match(ausgefuehrt, /test -n "\$\{KNOWN_HOSTS:-\}" \|\| \{/);
        assert.match(ausgefuehrt, /ssh-keygen -F "\$suchname" -f ~\/\.ssh\/known_hosts/);
        assert.match(ausgefuehrt, /suchname="\[\$HOST\]:\$\{PORT\}"/, 'bei abweichendem Port die Form [host]:port');
        // Geprüft wird der Aufruf, nicht das Wort: Die Fehlermeldung nennt
        // `ssh-keyscan` ausdrücklich, um davor zu warnen.
        assert.doesNotMatch(ausgefuehrt, /^\s*ssh-keyscan\s|\|\s*ssh-keyscan\s|\$\(ssh-keyscan/m);
      });

      it('hält den Ausgang der Aktivierung fest, statt blind abzubrechen', () => {
        assert.match(ausgefuehrt, /set \+e\s*\n\s*ssh [^\n]*\\\s*\n[^\n]*"\$\{befehl\}"\s*\n\s*code=\$\?\s*\n\s*set -e\s*\n\s*echo "code=\$\{code\}" >> "\$GITHUB_OUTPUT"/);
      });

      it('gehört zur gemeinsamen Nebenläufigkeitsgruppe', () => {
        const text = weg.text === ausfuehren ? vorlage : weg.text;
        assert.match(text, /concurrency:\s*\n\s*group: clenaris-auslieferung-production\s*\n\s*cancel-in-progress: false/);
      });
    });
  }

  it('deploy.yml prüft die Beilage: Commit, Lauf, main, auslieferbar, gemessene Summe', () => {
    const beilage = schritt(auslieferung, 'Beilage prüfen');
    assert.match(beilage, /ERWARTET_COMMIT: \$\{\{ github\.sha \}\}/);
    assert.match(beilage, /ERWARTET_LAUF: \$\{\{ github\.run_id \}\}/);
    for (const regel of [
      "b.commit === commit",
      'ci.lauf === lauf',
      "ci.ref === 'refs/heads/main'",
      'b.auslieferbar === true',
      'b.archivSha256 === gemessen',
      'b.format === 2',
    ]) {
      assert.ok(beilage.includes(regel), `Beilage-Regel fehlt: ${regel}`);
    }
    assert.match(beilage, /sha256sum -c --status/);
  });

  it('deploy.yml: Ausgang 20 lässt den Auftrag mit klarer Meldung scheitern, jeder andere ausser 0 ebenso', () => {
    const aktivierung = schritt(auslieferung, 'Artefakt übertragen und aktivieren');
    assert.match(aktivierung, /20\)\s*echo "::error::[^"]*zurückgesprungen[^"]*"; exit 1 ;;/);
    assert.match(aktivierung, /0\)\s*echo "Aktiviert[^"]*" ;;/);
    for (const code of ['11', '10', '30', '\\*']) {
      assert.match(aktivierung, new RegExp(`${code}\\)\\s*echo "::error::[^"]*"; exit 1 ;;`), `Ausgang ${code}`);
    }
  });

  it('deploy.yml prüft von aussen die Identität: Commit, Build-ID der Beilage, belegt', () => {
    const aussen = schritt(auslieferung, 'Identität von aussen prüfen');
    assert.match(aussen, /ERWARTET: \$\{\{ github\.sha \}\}/);
    assert.match(aussen, /BUILD_ID: \$\{\{ steps\.beilage\.outputs\.buildid \}\}/);
    assert.match(aussen, /\[ "\$version" = "\$ERWARTET" \] && \[ "\$build" = "\$BUILD_ID" \] && \[ "\$identitaet" = "belegt" \]/);
  });

  /**
   * Ein von Hand ausgelöster Lauf auf `main` (etwa für `reproduzierbarkeit`)
   * baut den laufenden Commit mit einer neuen Build-ID. Die Aktivierung
   * schaltet darauf nicht um (Ausgang 10, nichts geändert); der Auftrag
   * fragt deshalb vorher von aussen und liefert diesen Fall gar nicht erst
   * aus — statt bei jeder Handauslösung rot zu werden.
   */
  it('deploy.yml liefert einen zweiten Bau des laufenden Commits nicht aus, sondern zeigt ihn an', () => {
    const vorab = schritt(auslieferung, 'Läuft dieser Commit schon als anderer Bau?');
    assert.match(vorab, /^\s+id: vorab\s*$/m);
    assert.match(vorab, /ERWARTET: \$\{\{ github\.sha \}\}/);
    assert.match(vorab, /BUILD_ID: \$\{\{ steps\.beilage\.outputs\.buildid \}\}/);
    // Nur genau dieser Commit, belegt, mit einer anderen, wohlgeformten Build-ID.
    assert.match(vorab, /\[ "\$version" = "\$ERWARTET" \] && \[ "\$identitaet" = "belegt" \]/);
    assert.match(vorab, /\[\[ "\$build" =~ \^\[A-Za-z0-9\._-\]\{1,200\}\$ \]\] && \[ "\$build" != "\$BUILD_ID" \]/);
    assert.match(vorab, /echo "laeuft=\$\{laeuft\}" >> "\$GITHUB_OUTPUT"/);
    assert.doesNotMatch(ohneKommentare(vorab), /^\s*(ssh|scp)\s/m, 'die Frage geht nur an die öffentliche Adresse, nie an den Server');
    for (const name of ['Artefakt übertragen und aktivieren', 'Identität von aussen prüfen']) {
      assert.match(schritt(auslieferung, name), /^\s+if: steps\.vorab\.outputs\.laeuft != 'ja'\s*$/m, name);
    }
    const reihenfolge = schritte(auslieferung).map((s) => s.name);
    assert.ok(
      reihenfolge.indexOf('Beilage prüfen') < reihenfolge.indexOf('Läuft dieser Commit schon als anderer Bau?') &&
        reihenfolge.indexOf('Läuft dieser Commit schon als anderer Bau?') < reihenfolge.indexOf('Artefakt übertragen und aktivieren'),
      'nach der Beilage (sie liefert die Build-ID), vor jeder Übertragung',
    );
  });

  it('die Aktivierung selbst prüft auf dem Server dieselbe Identität', () => {
    // Die Regel steht einmal (`identitaetStimmt`) und wird aus dem neuen
    // Release heraus aufgerufen; ihr Verhalten prüft release-ruecksprung.test.ts.
    const umschaltung = lesen('scripts', 'release', 'umschaltung.ts');
    assert.match(umschaltung, /g\.identitaet === 'belegt' && g\.version === erwartet\.commit && g\.buildId === erwartet\.buildId/);
    assert.match(aktivieren, /"\$\{TSX\[@\]\}" "\$\{ZIEL\}\/scripts\/release-umschalten\.ts" umschalten --basis "\$\{BASIS\}" --ziel "\$\{ZIEL\}" --port "\$\{PORT\}" 9>&-/);
  });
});

describe('release-aktivieren.sh — Vertrag C3', () => {
  const ausgefuehrt = ohneKommentare(aktivieren);

  it('hält die gemeinsame Sperre und meldet 11, wenn sie besetzt ist', () => {
    assert.match(ausgefuehrt, /readonly SPERRE="\$\{BASIS\}\/\.release\.lock"/);
    assert.match(ausgefuehrt, /exec 9>>"\$\{SPERRE\}"\s*\nif ! flock -n 9; then[\s\S]*?melden 11 GESPERRT/);
  });

  it('verlangt die erwartete Summe und vergleicht sie mit Messung und .sha256', () => {
    assert.match(ausgefuehrt, /--erwartet-sha256\)/);
    assert.match(ausgefuehrt, /\[\[ "\$\{ERWARTET\}" =~ \^\[0-9a-f\]\{64\}\$ \]\] \\\s*\n\s*\|\| fail/);
    assert.match(ausgefuehrt, /MESSUNG="\$\(sha256sum -- "\$\{KOPIE\}"/);
    assert.match(ausgefuehrt, /\[\[ "\$\{MESSUNG\}" == "\$\{ERWARTET\}" \]\]/);
    assert.match(ausgefuehrt, /\[\[ "\$\{MESSUNG\}" == "\$\{NOTIERT\}" \]\]/);
    // Gemessen und entpackt wird dieselbe, private Kopie.
    assert.match(ausgefuehrt, /tar -xzf "\$\{KOPIE\}" -C "\$\{NEU\}"/);
  });

  it('entpackt immer frisch und räumt über eine Falle auf', () => {
    assert.match(ausgefuehrt, /NEU="\$\{ZIEL\}\.tmp\.\$\$"/);
    assert.match(ausgefuehrt, /trap beim_ende EXIT/);
    assert.match(ausgefuehrt, /aufraeumen\(\) \{[\s\S]*rm -rf -- "\$\{NEU\}"[\s\S]*\}/);
    assert.match(ausgefuehrt, /\.next\/BUILD_ID[\s\S]*== "\$\{BUILD_ID\}"/);
    assert.match(ausgefuehrt, /mv -T -- "\$\{NEU\}" "\$\{ZIEL\}"/);
    assert.doesNotMatch(aktivieren, /unverändert wiederverwendet\."/, 'kein Zweig, der ein vorhandenes Verzeichnis ungeprüft nimmt');
  });

  it('kennt genau die Ausgänge 0, 10, 11, 20, 30 und schreibt immer ERGEBNIS', () => {
    const gemeldet = new Set([...ausgefuehrt.matchAll(/melden (\d+) ([A-Z_]+)/g)].map((t) => `${t[1]} ${t[2]}`));
    assert.deepEqual([...gemeldet].sort(), ['0 AKTIV', '11 GESPERRT', '20 ZURUECK', '30 UNKLAR']);
    assert.match(ausgefuehrt, /local code=10 zustand="NICHT_UMGESCHALTET"/, 'jeder Abbruch vor dem Umschalten ist 10');
    assert.match(ausgefuehrt, /umschaltung\|abschluss\) code=30; zustand="UNKLAR"/, 'jeder Abbruch ab dem Umschalten ist 30');
    assert.equal((ausgefuehrt.match(/printf 'ERGEBNIS \{"code":%d,"zustand":"%s","commit":"%s"\}\\n'/g) ?? []).length, 2);
  });

  it('Reihenfolge: Sperre → Summe → Manifest → frisch entpacken → Vorprüfung → Migration → Umschalten', () => {
    const marken = [
      'flock -n 9',
      'sha256sum --',
      'tar -xzOf "${KOPIE}" RELEASE.json',
      'tar -xzf "${KOPIE}"',
      'artefakt --verzeichnis "${NEU}"',
      'react-hydrationskorrektur.mjs --pruefen',
      'production-preflight.ts --phase vor-migration',
      'scripts/migration-preflight.ts',
      'scripts/db-backup.ts',
      'migrate deploy',
      'scripts/production-preflight.ts \\',
      'release-umschalten.ts" umschalten',
    ];
    const stellen = marken.map((m) => ausgefuehrt.indexOf(m));
    marken.forEach((m, i) => assert.ok(stellen[i]! > 0, `fehlt: ${m}`));
    assert.deepEqual([...stellen].sort((a, b) => a - b), stellen, 'die Reihenfolge ist Teil des Vertrags');
  });

  it('das Werkzeug kommt aus dem neuen Release, nie aus current/ — und ohne die Sperre', () => {
    assert.match(ausgefuehrt, /WERKZEUG_NEU=\(node "\$\{NEU\}\/node_modules\/tsx\/dist\/cli\.mjs" "\$\{NEU\}\/scripts\/release-umschalten\.ts"\)/);
    assert.doesNotMatch(ausgefuehrt, /current\/(scripts|deploy|node_modules)/);
    assert.doesNotMatch(ausgefuehrt, /\bnpx\b/, 'npx lädt Fehlendes aus dem Netz');
    for (const aufruf of ausgefuehrt.split(/\r?\n/).filter((z) => /release-umschalten\.ts" (umschalten|aktiv)|WERKZEUG_NEU\[@\]\}" (artefakt|aktiv)/.test(z))) {
      assert.match(aufruf, /9>&-/, `der pm2-Dienst darf die Sperre nicht erben: ${aufruf.trim()}`);
    }
  });

  it('pm2 save genau an einer Stelle — nach bestätigter Identität', () => {
    assert.doesNotMatch(ausgefuehrt, /pm2 (startOrReload|reload|save)/, 'das Skript schaltet nicht selbst');
    const werkzeug = lesen('scripts', 'release-umschalten.ts');
    // Seit 2026-10-01 nimmt der pm2-Aufruf eine Liste (damit die Prüfreihe ihn ersetzen kann).
    assert.match(werkzeug, /pm2\(\['save'\]\)/);
    assert.equal((werkzeug.match(/pm2\(\['save'\]\)/g) ?? []).length, 1, 'genau ein pm2 save im Werkzeug');
    const kern = lesen('scripts', 'release', 'umschaltung.ts');
    assert.equal((kern.match(/await b\.pm2Sichern\(\)/g) ?? []).length, 2, 'nach AKTIV und nach bestätigtem Rücksprung');
  });

  it('setzt APP_VERSION nirgends mehr', () => {
    for (const [name, text] of [
      ['release-aktivieren.sh', aktivieren],
      ['release-ruecksprung.sh', ruecksprungSh],
      ['deploy.yml', deployYml],
      ['release-ausfuehrer.yml', vorlage],
      ['release-umschalten.ts', lesen('scripts', 'release-umschalten.ts')],
    ] as const) {
      assert.doesNotMatch(ohneKommentare(text), /APP_VERSION=/, `${name} setzt APP_VERSION`);
    }
  });

  it('jede Aktivierung steht in aktivierungen.jsonl, Releases und Archive werden gemeinsam aufbewahrt', () => {
    assert.match(ausgefuehrt, /protokollieren\(\) \{[\s\S]*aktivierungen\.jsonl/);
    assert.match(ausgefuehrt, /melden\(\) \{[\s\S]*?protokollieren "\$\{code\}" "\$\{zustand\}"/);
    assert.match(ausgefuehrt, /BEHALTEN="\$\{CLENARIS_RELEASES_KEEP:-5\}"/);
    assert.match(ausgefuehrt, /mv -f -- "\$\{KOPIE\}" "\$\{BASIS\}\/archiv\/\$\{ARCHIVNAME\}"/);
    assert.match(ausgefuehrt, /mv -f -- "\$\{KOPIE\}\.sha256" "\$\{BASIS\}\/archiv\/\$\{ARCHIVNAME\}\.sha256"/);
    assert.match(ausgefuehrt, /aufbewahren\(\) \{[\s\S]*archiv\/clenaris-\*\.tar\.gz[\s\S]*\}/);
  });

  /**
   * Befund 2026-10-01: Das gemessene Archiv lag in `archiv/`, **bevor**
   * feststand, ob die Aktivierung gelingt — und vor der Prüfung „schon
   * aktiv?". Eine erneute Lieferung des laufenden Commits als anderer Bau
   * überschrieb so das aufbewahrte Archiv der laufenden Fassung, und ein
   * Rücksprung mit der notierten Summe war danach unmöglich. Jede Stelle,
   * die `archiv/clenaris-<commit>` schreibt, steht deshalb hinter dem
   * bestätigten Umschalten.
   */
  it('bewahrt das Archiv erst nach bestätigter Umschaltung auf — nie davor, nie im Wiederholungszweig', () => {
    const umschalten = ausgefuehrt.indexOf('release-umschalten.ts" umschalten');
    const bestaetigt = ausgefuehrt.indexOf('0)  PHASE="abschluss" ;;');
    assert.ok(umschalten > 0 && bestaetigt > umschalten, 'Umschaltung und ihr Ausgang 0 fehlen');
    const schreibend = [...ausgefuehrt.matchAll(/"\$\{BASIS\}\/archiv\/\$\{ARCHIVNAME\}/g)].map((t) => t.index ?? -1);
    assert.ok(schreibend.length >= 2, 'Archiv und .sha256 werden aufbewahrt');
    for (const stelle of schreibend) assert.ok(stelle > bestaetigt, 'archiv/ wird erst nach dem bestätigten Umschalten beschrieben');
    // Die Kopie wartet bis dahin unter einem Namen, den `aufbewahren` nie
    // als Archiv eines Release liest, und die Falle räumt sie weg.
    assert.match(ausgefuehrt, /KOPIE="\$\{BASIS\}\/archiv\/\.eingang\.\$\$\.tar\.gz"/);
    assert.match(ausgefuehrt, /aufraeumen\(\) \{[\s\S]*?rm -f -- "\$\{KOPIE\}" "\$\{KOPIE\}\.sha256"[\s\S]*?\}/);
  });

  it('derselbe Commit als anderer Bau: eigene Meldung, nicht umgeschaltet, Archiv unberührt', () => {
    const wiederholung = ausgefuehrt.slice(
      ausgefuehrt.indexOf('if [[ -n "${VORHER}" && "${VORHER}" == "${COMMIT}" ]]; then'),
      ausgefuehrt.indexOf('ln -sfn "${BASIS}/shared/.env"'),
    );
    assert.ok(wiederholung.length > 0, 'Wiederholungszweig fehlt oder steht nach dem Platzieren');
    assert.match(wiederholung, /aktiv --basis "\$\{BASIS\}" --ziel "\$\{ZIEL\}" --erwartet-aus "\$\{NEU\}"[^\n]*9>&- \\\s*\n\s*\|\| LAGE=\$\?/);
    assert.match(wiederholung, /0\) [^\n]*melden 0 AKTIV ;;/);
    assert.match(wiederholung, /5\) fail "Derselbe Commit \$\{COMMIT\} läuft bereits, aber als anderer Bau[^"]*nicht umgeschaltet[^"]*" ;;/);
    assert.match(wiederholung, /\*\) fail "[^"]*bestätigt seine Identität aber nicht[^"]*" ;;/);
    assert.doesNotMatch(wiederholung, /archiv\//, 'der Wiederholungszweig fasst archiv/ nicht an');
    // Dieselbe Zuordnung im Werkzeug: Ausgang 5 heisst „anderer Bau".
    assert.match(lesen('scripts', 'release-umschalten.ts'), /'anderer-bau': 5,/);
  });
});

describe('Rücksprung von Hand', () => {
  const ausgefuehrt = ohneKommentare(ruecksprungSh);

  it('release-ruecksprung.sh hält dieselbe Sperre und startet das Werkzeug aus current', () => {
    assert.match(ausgefuehrt, /readonly SPERRE="\$\{BASIS\}\/\.release\.lock"/);
    assert.match(ausgefuehrt, /exec 9>>"\$\{SPERRE\}"\s*\nif ! flock -n 9; then[\s\S]*?ergebnis 11 GESPERRT/);
    assert.match(ausgefuehrt, /AKTUELL="\$\(readlink -f -- "\$\{BASIS\}\/current"\)"/);
    assert.match(ausgefuehrt, /readonly WERKZEUG="\$\{AKTUELL\}\/scripts\/release-ruecksprung\.ts"/);
    assert.match(ausgefuehrt, /node "\$\{TSX\}" "\$\{WERKZEUG\}" --basis "\$\{BASIS\}" "\$@" 9>&-/);
    assert.doesNotMatch(ausgefuehrt, /exec node/, 'die Hülle muss leben, solange sie die Sperre hält');
  });

  it('der Rücksprung baut nicht, installiert nicht und kennt kein git', () => {
    const quelltext = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const datei of [['scripts', 'release-ruecksprung.ts'], ['scripts', 'release-umschalten.ts'], ['scripts', 'release', 'umschaltung.ts']]) {
      const code = quelltext(lesen(...datei));
      assert.doesNotMatch(code, /\bnpm\b|\bnpx\b|next build|['"]git['"]|\bgit\s/, `${datei.join('/')}: baut, installiert oder ruft git`);
    }
    assert.doesNotMatch(ausgefuehrt, /\bnpm\b|\bnpx\b|\bgit\b/);
  });

  it('scripts/deploy.sh bleibt eine Absage und nennt den Rücksprungweg', () => {
    const deploySh = lesen('scripts', 'deploy.sh');
    const befehle = deploySh.split(/\r?\n/).filter((z) => z.trim() !== '' && !/^\s*#/.test(z));
    const ersterAbbruch = befehle.findIndex((z) => /^exit 1\b/.test(z.trim()));
    assert.ok(ersterAbbruch > 0, 'exit 1 fehlt');
    assert.ok(befehle.slice(0, ersterAbbruch).every((z) => /^echo "/.test(z.trim())), 'vor dem Abbruch nur Meldungen');
    assert.match(befehle.slice(0, ersterAbbruch).join('\n'), /deploy\/v2\/release-ruecksprung\.sh --auf/);
  });
});

describe('Vorlagen unter deploy/v2', () => {
  /**
   * `workflow-ergaenzung.yml` war die Vorlage der Schritte, die seit dem
   * 2026-09-27 in `deploy.yml` stehen — seitdem eine zweite, abweichende
   * Beschreibung desselben Wegs (Skript aus `current/`, ohne erwartete Summe,
   * ohne Port). Sie ist entfernt; eine weitere Vorlage daneben entstünde nur
   * mit einer Prüfung in dieser Datei.
   */
  it('die einzige Workflow-Vorlage ist der Release-Ausführer', () => {
    assert.equal(existsSync(join(WURZEL, 'deploy', 'v2', 'workflow-ergaenzung.yml')), false);
    const vorlagen = readdirSync(join(WURZEL, 'deploy', 'v2')).filter((n) => /\.ya?ml$/.test(n));
    assert.deepEqual(vorlagen, ['release-ausfuehrer.yml']);
  });
});
