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
