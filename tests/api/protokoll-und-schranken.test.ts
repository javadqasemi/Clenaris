import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';

import { get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';

/**
 * Wave 1 — was protokolliert wird und was eine Schranke hat.
 *
 * **Warum diese Datei entstanden ist.** Ein Bericht hatte drei Lücken im
 * Prüfprotokoll gemeldet: Zuteilung, Objektänderung und Ausstellung
 * öffentlicher Zugangslinks. Die Nachprüfung am Code ergab: Zwei davon gab es
 * nicht — Objekt und Zuteilung werden sehr wohl protokolliert, nur eben in
 * der Route beziehungsweise in `job.service.ts` und nicht im gleichnamigen
 * Dienst. Gemessen worden war die falsche Stelle.
 *
 * Genau deshalb steht das hier als Prüfung und nicht als Notiz: Eine Aussage
 * über Protokollabdeckung, die sich an der Dateiablage orientiert statt am
 * Aufrufpfad, geht wieder schief. Diese Prüfungen fragen den Code, nicht die
 * Ordnerstruktur.
 *
 * Die dritte Lücke war echt und ist geschlossen.
 */

const wurzel = process.cwd();
const lies = (...teile: string[]) => readFileSync(join(wurzel, ...teile), 'utf8');

/** Alle `route.ts` unterhalb eines API-Pfads. */
function routen(...teile: string[]): { pfad: string; inhalt: string }[] {
  const wurzelPfad = join(wurzel, ...teile);
  const gefunden: { pfad: string; inhalt: string }[] = [];
  const gehe = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const eintrag of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, eintrag.name);
      if (eintrag.isDirectory()) gehe(p);
      else if (eintrag.name === 'route.ts') {
        gefunden.push({ pfad: p.slice(wurzel.length + 1).split(sep).join('/'), inhalt: readFileSync(p, 'utf8') });
      }
    }
  };
  gehe(wurzelPfad);
  return gefunden;
}

describe('Benachrichtigungen — jeder Endpunkt hat eine Schranke', () => {
  /**
   * Die vier Benachrichtigungsendpunkte waren die einzigen **angemeldeten**
   * Endpunkte des Systems ohne `rateLimit`. Der Zähler läuft auf jeder Seite
   * im App-Rahmen und liest bei jedem Aufruf die Datenbank; ohne Schranke
   * genügt ein angemeldetes Konto mit einer Schleife, um den Verbindungspool
   * zu belegen.
   */
  it('jede Route unter /api/notifications deklariert ein rateLimit', () => {
    const gefunden = routen('src', 'app', 'api', 'notifications');
    assert.ok(gefunden.length >= 4, `zu wenige Routen gefunden: ${gefunden.length}`);
    for (const { pfad, inhalt } of gefunden) {
      assert.match(inhalt, /rateLimit:\s*'(apiRead|apiWrite)'/, `${pfad} ohne rateLimit`);
    }
  });

  it('schreibende Benachrichtigungsendpunkte nehmen das Schreibkontingent', () => {
    for (const { pfad, inhalt } of routen('src', 'app', 'api', 'notifications')) {
      if (!/export const (POST|PATCH|DELETE)/.test(inhalt)) continue;
      assert.match(
        inhalt,
        /rateLimit:\s*'apiWrite'/,
        `${pfad} schreibt, nimmt aber nicht 'apiWrite'`,
      );
    }
  });
});

describe('Zugangslinks — Ausstellung steht im Prüfprotokoll', () => {
  const dienst = lies('src', 'server', 'services', 'access-token.service.ts');

  it('issuePublicToken schreibt einen Protokolleintrag', () => {
    const ab = dienst.indexOf('export async function issuePublicToken');
    const bis = dienst.indexOf('export type TokenRejection');
    assert.ok(ab > 0 && bis > ab, 'beide Marken müssen existieren');
    const block = dienst.slice(ab, bis);
    assert.match(block, /audit\.created\(/, 'die Ausstellung eines Zugangs gehört ins Protokoll');
    assert.match(block, /entity: 'PublicAccessToken'/);
  });

  /**
   * Der rohe Token ist der Zugang. Ein Protokoll, das ihn enthielte, wäre
   * selbst ein Schlüsselbund — und es wird von anderen Personen gelesen als
   * denen, die den Link bekommen sollten.
   */
  it('der rohe Token landet in keinem Protokolleintrag', () => {
    const ab = dienst.indexOf('export async function issuePublicToken');
    const bis = dienst.indexOf('export type TokenRejection');
    const block = dienst.slice(ab, bis);
    /**
     * Nur der Aufruf selbst, nicht der Rest der Funktion: Danach folgt
     * `return { raw, record }`, und das ist genau richtig — der rohe Token
     * geht an die aufrufende Stelle, die den Link baut. Eine erste Fassung
     * dieser Prüfung schaute bis zum Funktionsende und schlug deshalb an
     * der Rückgabe an.
     */
    const start = block.indexOf('audit.created(');
    assert.ok(start > 0, 'der Protokollaufruf muss existieren');
    const auditAufruf = block.slice(start, block.indexOf('});', start) + 3);
    assert.doesNotMatch(
      auditAufruf,
      /\braw\b/,
      'der rohe Token darf im Protokolleintrag nicht vorkommen',
    );
    assert.doesNotMatch(auditAufruf, /tokenHash/, 'auch der Hash gehört nicht ins Protokoll');
  });

  it('der Protokolleintrag nennt Zweck, Ressource und Frist', () => {
    const block = dienst.slice(dienst.indexOf('audit.created('));
    assert.match(block, /params\.purpose/);
    assert.match(block, /params\.resourceId/);
    assert.match(block, /expiresAt/);
  });
});

describe('Zuteilung — das Protokoll nennt die zugeteilten Personen', () => {
  /**
   * „an 3 Person(en) zugeteilt" beantwortet die Frage nicht, die im Ernstfall
   * gestellt wird: *wer* war an diesem Tag auf diesem Objekt. Die Zuteilung
   * selbst wird beim nächsten Umdisponieren überschrieben (`deleteMany`);
   * ohne die Kennungen im Protokoll ist der frühere Stand danach verloren.
   */
  it('assignJob legt die Kennungen der Personen in changes ab', () => {
    const quelle = lies('src', 'server', 'services', 'job.service.ts');
    const ab = quelle.indexOf('export async function assignJob');
    assert.ok(ab > 0, 'assignJob muss existieren');
    const block = quelle.slice(ab, ab + 4000);
    assert.match(block, /audit\.updated\(/, 'die Zuteilung muss protokolliert werden');
    assert.match(
      block,
      /changes:\s*\{[^}]*employeeIds:\s*params\.employeeIds/,
      'die Kennungen der zugeteilten Personen gehören in den Eintrag',
    );
  });

  it('moveJob protokolliert ebenfalls', () => {
    const quelle = lies('src', 'server', 'services', 'job.service.ts');
    const ab = quelle.indexOf('export async function moveJob');
    const block = quelle.slice(ab, ab + 4000);
    assert.match(block, /audit\.updated\(/);
  });
});

describe('Objektänderungen — protokolliert, Alarmcode redigiert', () => {
  /**
   * Gegenprobe zu einem Fehlbefund: Objekte *sind* protokolliert. Die
   * Mutation liegt in der Route, nicht im gleichnamigen Dienst — und `diff()`
   * redigiert den Alarmcode, sodass die **Tatsache** der Änderung sichtbar
   * bleibt, ohne dass der Wert im Protokoll steht.
   */
  it('Anlegen und Ändern eines Objekts schreiben einen Eintrag', () => {
    assert.match(lies('src', 'app', 'api', 'properties', 'route.ts'), /audit\.created\(/);
    assert.match(lies('src', 'app', 'api', 'properties', '[id]', 'route.ts'), /audit\.updated\(/);
  });

  it('der Alarmcode gehört zu den redigierten Feldern', () => {
    const auditModul = lies('src', 'lib', 'audit.ts');
    const ab = auditModul.indexOf('REDACTED_FIELDS');
    const block = auditModul.slice(ab, auditModul.indexOf(']', ab));
    for (const feld of ['alarmCode', 'ahvNumber', 'twoFactorSecret', 'passwordHash', 'iban', 'tokenHash']) {
      assert.match(block, new RegExp(`'${feld}'`), `${feld} muss redigiert werden`);
    }
  });
});

describe('KI — keine Klarnamen an den Anbieter', () => {
  const merkmale = lies('src', 'lib', 'ai', 'features.ts');

  /**
   * `suggestStaffing` schickte Klarnamen und Datenbankkennungen der
   * Mitarbeitenden an einen Auftragsverarbeiter im Ausland, während die
   * Dokumentation zusicherte, es würden keine personenbezogenen Daten
   * gesendet. Beides zugleich konnte nicht stimmen.
   */
  it('der Personalvorschlag setzt keinen Namen in den Prompt', () => {
    const ab = merkmale.indexOf('export async function suggestStaffing');
    const bis = merkmale.indexOf('export async function scoreLead');
    assert.ok(ab > 0 && bis > ab, 'beide Funktionen müssen existieren');
    const block = merkmale.slice(ab, bis);
    const prompt = block.slice(block.indexOf('prompt:'), block.indexOf('schema:'));
    assert.doesNotMatch(prompt, /\$\{e\.name\}/, 'der Klarname darf nicht in den Prompt');
    assert.doesNotMatch(prompt, /\$\{e\.id\}/, 'auch die Datenbankkennung nicht');
    assert.doesNotMatch(prompt, /\$\{j\.id\}/);
  });

  it('der Personalvorschlag arbeitet mit Kürzeln und übersetzt zurück', () => {
    const ab = merkmale.indexOf('export async function suggestStaffing');
    const bis = merkmale.indexOf('export async function scoreLead');
    const block = merkmale.slice(ab, bis);
    assert.match(block, /personKuerzel/, 'es braucht eine Pseudonymzuordnung');
    assert.match(block, /personZurueck/, 'und eine Rückübersetzung');
    assert.match(block, /P\$\{i \+ 1\}/, 'Kürzel je Anfrage, nicht dauerhaft');
  });

  /**
   * Ein Kürzel, das wir nicht vergeben haben, darf nicht als Datensatzbezug
   * weiterwandern — das Modell kann sich eines ausdenken.
   */
  it('unbekannte Kürzel werden verworfen statt durchgereicht', () => {
    const ab = merkmale.indexOf('export async function suggestStaffing');
    const bis = merkmale.indexOf('export async function scoreLead');
    const block = merkmale.slice(ab, bis);
    assert.match(block, /flatMap/, 'nicht auflösbare Einträge müssen entfallen können');
    assert.match(block, /filter\(\(id\): id is string => Boolean\(id\)\)/);
  });
});

describe('Prüfprotokoll über HTTP — die Seite antwortet nur der Systemverantwortung', () => {
  let jars: Record<AccountName, string>;

  before(async () => {
    await requireServer();
    jars = await loginAll();
  });

  it('die Systemverantwortung sieht das Protokoll', async () => {
    const antwort = await get('/admin/protokoll', { jar: jars.super });
    assert.equal(antwort.status, 200);
  });

  /**
   * `audit:read` hat ausschliesslich SUPER_ADMIN — wer überwacht wird, soll
   * die Überwachung nicht einsehen.
   *
   * **Die Abweisung ist eine Umleitung, kein 404, und das ist Absicht.**
   * `/admin/protokoll` steht in `PERMISSION_ROUTES`; die Middleware greift
   * deshalb *vor* dem Rendern und schickt an den Bereichsanfang zurück
   * (`middleware.ts:83–86`). Der Grund steht dort: Sobald eine Seite mit
   * `force-dynamic` zu streamen beginnt, steht ihr Statuscode fest — ein
   * späteres `requirePagePermission()` lieferte dann eine 404-Ansicht unter
   * einer 200. Die Middleware entscheidet früher und damit ehrlicher.
   *
   * Preis dieser Wahl: Die Umleitung verrät, dass der Pfad geschützt ist,
   * während ein 404 die Existenz verborgen hätte. Das ist bewusst so
   * gewichtet — wirksame Durchsetzung vor Verschleierung.
   *
   * Geprüft wird deshalb die Eigenschaft, auf die es ankommt: **kein 200 und
   * kein Protokollinhalt.**
   */
  for (const rolle of ['admin', 'manager'] as const) {
    it(`${rolle} bekommt das Protokoll nicht`, async () => {
      const antwort = await get('/admin/protokoll', { jar: jars[rolle] });
      assert.notEqual(antwort.status, 200, 'die Seite darf nicht ausgeliefert werden');
      assert.ok(
        [301, 302, 303, 307, 308, 403, 404].includes(antwort.status),
        `erwartet Umleitung oder Abweisung, war ${antwort.status}`,
      );
      assert.doesNotMatch(
        antwort.text ?? '',
        /Prüfprotokoll/,
        'kein Protokollinhalt in der Antwort',
      );
    });
  }
});
