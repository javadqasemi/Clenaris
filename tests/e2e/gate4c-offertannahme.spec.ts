import type { Page } from '@playwright/test';

import { letzteMail, linksIn } from '../helpers/mail';
import { testDb } from '../helpers/testdb';

import { expect, test } from './helpers/basis';
import {
  konsoleUeberwachen,
  netzUeberwachen,
  tokenNirgendsSichtbar,
  unterschriftZeichnen,
  type Netzwache,
} from './helpers/browser';
import { frischAnmelden, offerteAnlegen, pfadVon, stammdatenLesen, versendenUndLinkLesen } from './helpers/bestand';

/**
 * Gate 4C im echten Browser — von der versendeten E-Mail bis zum Ergebnis.
 *
 * `tests/api/offertannahme.test.ts` fährt denselben Weg über HTTP und prüft
 * die Fachregeln erschöpfend: dass `ACCEPT` nicht annimmt, sondern einfriert;
 * dass vier gleichzeitige Annahmen einen Vorgang ergeben; dass eine geänderte
 * Offerte den offenen Vorgang abbricht. Nichts davon wird hier wiederholt.
 *
 * Was hier hinzukommt, sind die drei Dinge, die nur ein Browser zeigt:
 *
 *  • Der **Tausch** läuft im Browser ab und nirgends sonst: Fragment lesen,
 *    `history.replaceState`, `POST` mit dem Token im Körper, `location.replace`.
 *    Ob danach tatsächlich nichts mehr übrig ist, lässt sich nur an einem
 *    Browser messen — Verlauf, Adresse, Referrer und DOM gibt es nur dort.
 *  • Die **gezeichnete** Unterschrift entsteht aus Pointer-Events auf einem
 *    Canvas. Über HTTP lässt sich nur prüfen, dass der Server ein PNG annimmt.
 *  • Die **Maske** selbst: Dass die Schaltfläche erst freigibt, wenn
 *    Zustimmung, Name und Unterschrift vorliegen, steht in keiner Route.
 */

const db = testDb();

let adminJar = '';
let kundeId = '';

test.beforeAll(async () => {
  adminJar = await frischAnmelden('admin');
  kundeId = (await stammdatenLesen(adminJar)).customerId;
});

// ---------------------------------------------------------------------------
//  Werkzeuge
// ---------------------------------------------------------------------------

interface Annahme {
  quoteId: string;
  offertPfad: string;
  rohzugang: string;
  publicId: string;
}

/**
 * Bis zur Unterzeichnungsseite — über die Maske, mit dem Link aus dem
 * Postausgang.
 *
 * Der rohe Zugang wird dabei aus dem **Antwortkörper** der Annahmeroute
 * gelesen, nicht aus der Adresszeile: Die Tauschseite entfernt das Fragment im
 * ersten Effekt, und ein Test, der dort schneller sein will, prüfte am Ende
 * eine Zeitverzögerung statt einer Zusicherung. Der Körper ist ausserdem genau
 * der Ort, an dem der Wert laut Entwurf stehen darf.
 */
async function bisZurUnterzeichnung(page: Page, netz: Netzwache): Promise<Annahme> {
  const quote = await offerteAnlegen(adminJar, kundeId);
  const offertPfad = pfadVon(await versendenUndLinkLesen(quote.id, adminJar));

  /**
   * Den Antwortkörper der Annahmeroute mitlesen — über `route`, nicht über
   * `page.on('response')`.
   *
   * Der Unterschied ist kein Geschmack: Die Maske ruft unmittelbar nach der
   * Antwort `window.location.assign`. Ein nachträgliches `response.json()`
   * greift dann in einen Kontext, den der Browser gerade verwirft, und liefert
   * mal den Körper und mal nichts — beobachtet in genau diesem Fall. Über
   * `route.fetch()` liegt der Körper vor, bevor die Seite ihn überhaupt sieht.
   */
  let rohzugang = '';
  await page.route('**/api/public/quotes/*/respond', async (route) => {
    const antwort = await route.fetch();
    const text = await antwort.text();
    const treffer = /"signatureUrl":"\/signieren#t=([0-9a-f]{64})"/.exec(text);
    if (treffer) rohzugang = treffer[1]!;
    await route.fulfill({ response: antwort, body: text });
  });

  // Die Offertseite öffnet sich ohne Anmeldung, allein mit dem versendeten Link.
  await page.goto(offertPfad);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Möchten Sie die Offerte annehmen?' })).toBeVisible();

  await page.getByRole('button', { name: 'Offerte annehmen' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Weiter zur Unterzeichnung' }).click();

  // Der Tausch führt auf die saubere Adresse — ohne Zutun, ohne Geheimnis darin.
  await page.waitForURL(/\/signieren\/s\/[0-9a-f]{32}$/, { timeout: 30_000 });
  const publicId = /\/signieren\/s\/([0-9a-f]{32})$/.exec(page.url())![1]!;

  expect(rohzugang, 'Die Annahmeroute hat keinen Zugang im Fragment geliefert.').toMatch(/^[0-9a-f]{64}$/);
  expect(netz.eintraege.length).toBeGreaterThan(0);

  return { quoteId: quote.id, offertPfad, rohzugang, publicId };
}

/** Zustimmung und Name — der Teil, der für beide Unterschriftsarten gleich ist. */
async function zustimmenUndBenennen(page: Page, name: string): Promise<void> {
  await expect(page.getByRole('heading', { name: '1. Dokument lesen' })).toBeVisible();
  // Das eingefrorene PDF wird tatsächlich gerendert, nicht nur eingebunden.
  await expect(page.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });

  const zustimmung = page.getByRole('checkbox');
  await expect(zustimmung).toBeVisible();
  await zustimmung.click();

  await page.locator('#sig-name').fill(name);
}

const unterzeichnenSchaltflaeche = (page: Page) =>
  page.getByRole('button', { name: 'Verbindlich elektronisch unterzeichnen' });

const quoteLesen = (id: string) =>
  db!.quote.findUniqueOrThrow({ where: { id }, select: { status: true, acceptedAt: true } });

// ---------------------------------------------------------------------------
//  § 9 — Der vollständige Weg, getippt
// ---------------------------------------------------------------------------

test('nimmt eine Offerte getippt an — versendeter Link, Tausch, Zustimmung, Abschluss, Ergebnis', async ({
  page,
  context,
}) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page);
  const netz = netzUeberwachen(context);

  const annahme = await bisZurUnterzeichnung(page, netz);

  // — § 29: Nach dem Tausch ist der rohe Zugang nirgends mehr zu finden.
  await tokenNirgendsSichtbar(page, netz, annahme.rohzugang);

  // — Die Offerte ist noch nicht angenommen; der Start entscheidet nichts.
  expect((await quoteLesen(annahme.quoteId)).status).not.toBe('ACCEPTED');

  await zustimmenUndBenennen(page, 'Nicole Wyss');
  await page.getByRole('radio', { name: 'Tippen' }).click();
  await expect(unterzeichnenSchaltflaeche(page)).toBeEnabled();
  await unterzeichnenSchaltflaeche(page).click();

  await expect(page.getByText('Unterzeichnet', { exact: true })).toBeVisible({ timeout: 30_000 });

  // — Erst jetzt ist die Offerte angenommen.
  await expect.poll(async () => (await quoteLesen(annahme.quoteId)).status, { timeout: 20_000 }).toBe('ACCEPTED');

  // — Und der rohe Zugang ist auch danach nirgends aufgetaucht.
  await tokenNirgendsSichtbar(page, netz, annahme.rohzugang);
  konsole.keineFehler();

  // -------------------------------------------------------------------------
  //  Der Ergebnislink — ebenfalls aus dem tatsächlich versendeten Postausgang
  // -------------------------------------------------------------------------

  const mail = letzteMail({ subjectEnthaelt: 'Unterzeichnet:' });
  expect(mail, 'Keine Abschlussnachricht im Postausgang.').not.toBeNull();

  const ergebnisLink = linksIn(mail!).find((link) => /\/signieren\/ergebnis#t=[0-9a-f]{64}$/.test(link));
  expect(ergebnisLink, 'Kein Ergebnislink in der Abschlussnachricht.').toBeTruthy();
  const ergebnisZugang = /#t=([0-9a-f]{64})$/.exec(ergebnisLink!)![1]!;
  expect(ergebnisZugang, 'Der Ergebnislink trägt denselben Zugang wie die Unterzeichnung.').not.toBe(annahme.rohzugang);

  await page.goto(`${pfadVon(ergebnisLink!)}#t=${ergebnisZugang}`);
  await page.waitForURL(/\/signieren\/ergebnis\/[0-9a-f]{32}$/, { timeout: 30_000 });

  await expect(page.getByText('Elektronisch unterzeichnet')).toBeVisible();
  await expect(page.locator('[data-pdf-viewer] canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: /Unterzeichnetes Dokument/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Signaturprotokoll/ })).toBeVisible();
  await expect(page.getByText('SHA-256 Original')).toBeVisible();

  await tokenNirgendsSichtbar(page, netz, ergebnisZugang);
  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 10, § 11 — Gezeichnet, mit der Maus des Browsers
// ---------------------------------------------------------------------------

test('nimmt eine Offerte gezeichnet an — echte Mausbewegung auf dem Unterschriftenfeld', async ({ page, context }) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const konsole = konsoleUeberwachen(page);
  const netz = netzUeberwachen(context);

  const annahme = await bisZurUnterzeichnung(page, netz);
  await zustimmenUndBenennen(page, 'Nicole Wyss');

  // „Zeichnen" ist die Vorgabe; ausdrücklich gewählt, damit der Fall nicht an
  // einer geänderten Vorbelegung still vorbeiläuft.
  await page.getByRole('radio', { name: 'Zeichnen' }).click();
  await expect(page.getByText('Hier unterschreiben')).toBeVisible();

  /**
   * Ohne Strich bleibt die Schaltfläche gesperrt — das ist die Aussage, die
   * den Canvas-Test überhaupt tragfähig macht: Wenn sie danach freigibt, ist
   * die Zeichnung tatsächlich entstanden und nicht nur ein Zustand gesetzt
   * worden.
   */
  await expect(unterzeichnenSchaltflaeche(page)).toBeDisabled();

  await unterschriftZeichnen(page);

  // Der Platzhalter verschwindet, sobald Striche auf der Fläche sind.
  await expect(page.getByText('Hier unterschreiben')).toHaveCount(0);
  await expect(unterzeichnenSchaltflaeche(page)).toBeEnabled();

  await unterzeichnenSchaltflaeche(page).click();
  await expect(page.getByText('Unterzeichnet', { exact: true })).toBeVisible({ timeout: 30_000 });

  await expect.poll(async () => (await quoteLesen(annahme.quoteId)).status, { timeout: 20_000 }).toBe('ACCEPTED');

  /**
   * Und die Unterschrift ist als **gezeichnet** festgehalten, mit einem Bild,
   * das aus dieser Mausbewegung stammt. Ohne diese Zeile bewiese der Fall nur,
   * dass sich etwas anklicken liess.
   */
  const teilnehmer = await db!.signatureParticipant.findFirstOrThrow({
    where: { request: { quoteId: annahme.quoteId }, status: 'SIGNED' },
    select: { signatureMethod: true, signatureArtifactId: true, signatureArtifactHash: true },
  });
  expect(teilnehmer.signatureMethod).toBe('DRAWN');
  expect(teilnehmer.signatureArtifactId, 'Kein abgelegtes Unterschriftsbild.').not.toBeNull();
  expect(teilnehmer.signatureArtifactHash).toMatch(/^[0-9a-f]{64}$/);

  await tokenNirgendsSichtbar(page, netz, annahme.rohzugang);
  konsole.keineFehler();
});

// ---------------------------------------------------------------------------
//  § 26 — Zugänglichkeit der Unterzeichnungsseite
// ---------------------------------------------------------------------------

test('gibt der Unterzeichnungsseite Beschriftungen, Tastaturfokus und wahrnehmbare Meldungen', async ({
  page,
  context,
}) => {
  test.skip(!db, 'Keine Testdatenbank.');
  const netz = netzUeberwachen(context);
  await bisZurUnterzeichnung(page, netz);

  // Die Abschnitte sind benannt und in der richtigen Ordnung.
  await expect(page.getByRole('region', { name: 'Dokument' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Zustimmung und Unterschrift' })).toBeVisible();

  // Das Namensfeld hat ein verknüpftes Label.
  await expect(page.getByLabel('Ihr Name')).toBeVisible();

  // Die Wahl der Unterschriftsart ist eine benannte Gruppe mit Radios.
  const gruppe = page.getByRole('radiogroup', { name: 'Art der Unterschrift' });
  await expect(gruppe).toBeVisible();
  await expect(gruppe.getByRole('radio')).toHaveCount(2);

  // Das Unterschriftenfeld sagt, was es ist.
  await expect(page.getByRole('img', { name: /Unterschriftenfeld/ })).toBeVisible();

  // Die Zustimmung lässt sich mit der Tastatur setzen — ohne Maus kein Fallstrick.
  const zustimmung = page.getByRole('checkbox');
  await zustimmung.focus();
  await zustimmung.press(' ');
  await expect(zustimmung).toHaveAttribute('aria-checked', 'true');

  // Kein Fokus, der nicht mehr weiterkommt: Zehn Tabulatorschritte erreichen
  // mehr als ein Element und enden nicht auf demselben.
  const besucht = new Set<string>();
  for (let schritt = 0; schritt < 10; schritt++) {
    await page.keyboard.press('Tab');
    besucht.add(
      await page.evaluate(() => {
        const aktiv = document.activeElement;
        return aktiv ? `${aktiv.tagName}#${aktiv.id}.${aktiv.className.slice(0, 20)}` : 'keins';
      }),
    );
  }
  expect(besucht.size, 'Der Tastaturfokus kommt nicht weiter — Verdacht auf Fokusfalle.').toBeGreaterThan(3);

  // Eine Fehlermeldung wäre wahrnehmbar: Der Bereich dafür ist eine Meldung,
  // kein stiller Textknoten. Ausgelöst wird sie hier nicht — dafür gibt es die
  // HTTP-Reihe —, geprüft wird die Zusicherung des Rahmens.
  await expect(page.getByText(/Keine qualifizierte elektronische Signatur/)).toBeVisible();
});
