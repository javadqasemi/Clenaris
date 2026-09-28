import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, data, get, requireServer } from '../helpers/client';
import { loginAll, ROLE_ORDER, type AccountName } from '../helpers/accounts';
import { pageTitle } from '../helpers/markup';
import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Die Redaktion: ändern → prüfen → veröffentlichen → zurücksetzen.
 *
 * Der Anspruch an das System lautet, dass die Verwaltung die ganze Website
 * pflegen kann, ohne den Quelltext anzufassen, und dass eine veröffentlichte
 * Änderung sofort sichtbar wird. Das lässt sich nur so prüfen: schreiben,
 * veröffentlichen, die öffentliche Seite abrufen und nachsehen. Ein Test, der
 * nur den Schreibvorgang bestätigt, übersieht genau den Fehler, der hier zählt
 * — eine Änderung, die in der Datenbank landet und im Zwischenspeicher hängen
 * bleibt.
 *
 * **Speichern und Veröffentlichen sind seit der Einführung des Entwurfsstands
 * zwei Schritte.** Die zweite Prüfung unten hält das ausdrücklich fest: Nach
 * dem Speichern darf der neue Text auf der Website noch *nicht* stehen. Vorher
 * ging ein halb fertiger Satz mit dem Tastendruck live.
 *
 * Der Ausgangszustand wird am Ende wiederhergestellt: Ein leerer Wert bedeutet
 * „nimm den Auslieferungstext", nicht „zeige nichts".
 */

const MARKER = `Prüftext ${Date.now()}`;

let jars: Record<AccountName, string>;

const patchContent = (jar: string, entries: { key: string; value: unknown }[]) =>
  call('PATCH', '/api/content', { jar, body: { entries } });

const publishContent = (jar: string) =>
  call('POST', '/api/content', { jar, body: { action: 'publish' } });

/** Speichern *und* freigeben — der Normalfall in den übrigen Prüfungen. */
const publishEntries = async (jar: string, entries: { key: string; value: unknown }[]) => {
  const saved = await patchContent(jar, entries);
  if (saved.status !== 200) return saved;
  return publishContent(jar);
};

describe('Inhaltspflege', { concurrency: 1 }, async () => {
  await requireServer();
  jars = await loginAll();

  after(async () => {
    await publishEntries(jars.admin, [
      { key: 'home.hero.titleLine1', value: '' },
      { key: 'home.hero.bullets', value: [] },
    ]);
    // Ein zurückgesetzter Baustein hinterlässt einen leeren Entwurf, falls er
    // zuvor veröffentlicht war — der muss mit weg, sonst startet der nächste
    // Lauf mit offenen Entwürfen.
    await call('POST', '/api/content', { jar: jars.admin, body: { action: 'discard' } });
  });

  describe('Zugriffsschutz', () => {
    // Wer die Website ändern kann, ändert das Gesicht des Unternehmens.
    // Betriebsleitung, Mitarbeitende und Kundschaft haben dort nichts zu tun.
    const ALLOWED: Record<AccountName, boolean> = {
      super: true,
      admin: true,
      manager: false,
      employee: false,
      customer: false,
    };

    for (const role of ROLE_ORDER) {
      it(`${role}: ${ALLOWED[role] ? 'darf schreiben' : 'darf nicht schreiben'}`, async () => {
        const response = await patchContent(jars[role], [
          { key: 'home.hero.titleLine1', value: 'Sauber übergeben.' },
        ]);
        assert.equal(response.status, ALLOWED[role] ? 200 : 403);
      });
    }
  });

  describe('Änderungen erreichen die Website', () => {
    it('speichert Überschrift und Liste als Entwurf', async () => {
      const response = await patchContent(jars.admin, [
        { key: 'home.hero.titleLine1', value: MARKER },
        { key: 'home.hero.bullets', value: ['Erster Punkt', 'Zweiter Punkt'] },
      ]);
      assert.equal(response.status, 200, JSON.stringify(response.payload));
    });

    it('zeigt den Entwurf noch nicht auf der Startseite', async () => {
      // Der Kern der Trennung: Bis zur Freigabe liest die Kundschaft den alten
      // Stand. Ginge das schief, stünde jeder Zwischenstand sofort öffentlich.
      const home = await get('/');
      assert.ok(!home.text.includes(MARKER), 'der Entwurf ist vorzeitig öffentlich');
    });

    it('zeigt sie nach dem Veröffentlichen', async () => {
      const published = await publishContent(jars.admin);
      assert.equal(published.status, 200, JSON.stringify(published.payload));

      const home = await get('/');
      assert.ok(home.text.includes(MARKER), 'neue Überschrift fehlt');
      assert.ok(home.text.includes('Erster Punkt'), 'neue Liste fehlt');
      assert.ok(home.text.includes('Zweiter Punkt'));
      assert.ok(
        !home.text.includes('Keine versteckten Kosten'),
        'der alte Auslieferungstext steht noch daneben',
      );
    });
  });

  describe('Grenzen werden durchgesetzt', () => {
    it('weist zu langen Text ab', async () => {
      const response = await patchContent(jars.admin, [
        { key: 'home.hero.titleLine1', value: 'x'.repeat(200) },
      ]);
      assert.equal(response.status, 400);
    });

    it('weist einen unbekannten Schlüssel ab', async () => {
      // Sonst füllte sich die Tabelle mit Schlüsseln, die keine Seite liest.
      const response = await patchContent(jars.admin, [{ key: 'gibt.es.nicht', value: 'x' }]);
      assert.equal(response.status, 400);
    });

    it('weist den falschen Typ ab', async () => {
      const response = await patchContent(jars.admin, [
        { key: 'home.hero.bullets', value: 'kein Array' },
      ]);
      assert.equal(response.status, 400);
    });
  });

  describe('Zurücksetzen stellt den Auslieferungstext her', () => {
    it('nimmt einen leeren Wert an', async () => {
      const response = await publishEntries(jars.admin, [
        { key: 'home.hero.titleLine1', value: '' },
        { key: 'home.hero.bullets', value: [] },
      ]);
      assert.equal(response.status, 200);
    });

    it('zeigt danach wieder den Text aus dem Quelltext', async () => {
      const home = await get('/');
      assert.ok(home.text.includes('Sauber übergeben.'), 'Standardüberschrift fehlt');
      assert.ok(home.text.includes('Keine versteckten Kosten'), 'Standardliste fehlt');
      assert.ok(!home.text.includes(MARKER), 'der Prüftext steht noch da');
    });
  });

  describe('Vorschaumodus bleibt im Redaktionsrahmen', () => {
    /**
     * Der Fehler, den diese Fälle festhalten: Nach einem Besuch der Maske
     * blieb das Vorschau-Cookie im Browser, und jede öffentliche Seite im
     * selben Browser trug Bearbeitungsmarken — Rahmen beim Überfahren, Text
     * beim Klick beschreibbar. Marken gibt es jetzt nur mit Cookie *und*
     * Schreibrecht *und* im Rahmen der Maske (`Sec-Fetch-Dest: iframe`).
     */
    const FRAME = { 'sec-fetch-dest': 'iframe' };
    const MARK = 'data-cms-key';

    it('einschalten darf nur, wer Inhalte ändert', async () => {
      for (const role of ROLE_ORDER) {
        const response = await get('/api/content/preview?nur=1', { jar: jars[role] });
        const allowed = role === 'super' || role === 'admin';
        assert.equal(response.status, allowed ? 204 : 403, `${role}: HTTP ${response.status}`);
      }
      const guest = await get('/api/content/preview?nur=1');
      assert.equal(guest.status, 403);
    });

    it('zeigt Marken nur im Rahmen, nur mit Schreibrecht, und nicht mehr nach dem Ausschalten', async () => {
      const armed = await get('/api/content/preview?nur=1', { jar: jars.admin });
      assert.equal(armed.status, 204);
      assert.ok(armed.cookies.length > 0, 'Vorschau-Cookie gesetzt');
      const adminWithCookie = `${jars.admin}; ${armed.cookies}`;

      const plain = await get('/', { jar: adminWithCookie });
      assert.equal(plain.status, 200);
      assert.ok(!plain.text.includes(MARK), 'ausserhalb des Rahmens keine Marken — auch für die Administration');

      const framed = await get('/', { jar: adminWithCookie, headers: FRAME });
      assert.equal(framed.status, 200);
      assert.ok(framed.text.includes(MARK), 'im Rahmen der Maske Marken');

      const guest = await get('/', { jar: armed.cookies, headers: FRAME });
      assert.ok(!guest.text.includes(MARK), 'Cookie ohne Sitzung: keine Marken');

      const customer = await get('/', { jar: `${jars.customer}; ${armed.cookies}`, headers: FRAME });
      assert.ok(!customer.text.includes(MARK), 'Cookie mit Kundensitzung: keine Marken');

      const employee = await get('/', { jar: `${jars.employee}; ${armed.cookies}`, headers: FRAME });
      assert.ok(!employee.text.includes(MARK), 'Cookie mit Mitarbeitendensitzung: keine Marken');

      const off = await get('/api/content/preview?aus=1&nur=1', { jar: adminWithCookie });
      assert.equal(off.status, 204);
      const after = await get('/', { jar: `${jars.admin}; ${off.cookies}`, headers: FRAME });
      assert.ok(!after.text.includes(MARK), 'nach dem Ausschalten keine Marken, auch im Rahmen');
    });
  });

  describe('Der Redaktionsarbeitsplatz selbst', () => {
    /**
     * `/admin/inhalte` ist ein reiner Bearbeitungsplatz ohne Lesemodus. Er
     * hängt deshalb an `content:update`, nicht an einem Leserecht — wer nichts
     * ändern darf, hat dort nichts zu sehen.
     *
     * Erkannt wird die Seite an der Seitenauswahl über der Vorschau: Die
     * Felder selbst stehen nicht mehr im HTML, seit direkt in der Vorschau
     * geschrieben wird.
     */
    const ALLOWED: Record<AccountName, boolean> = {
      super: true,
      admin: true,
      manager: false,
      employee: false,
      customer: false,
    };

    for (const role of ROLE_ORDER) {
      it(`${role}: ${ALLOWED[role] ? 'sieht die Maske' : 'wird abgewiesen'}`, async () => {
        const response = await get('/admin/inhalte', { jar: jars[role] });
        const visible = response.status === 200 && response.text.includes('Seite in der Vorschau');

        if (ALLOWED[role]) {
          assert.ok(visible, `HTTP ${response.status}, Maske nicht im HTML`);
        } else {
          assert.ok(!visible, `HTTP ${response.status} — die Maske war sichtbar`);
          assert.notEqual(response.status, 200);
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------

describe('Suchmaschinenangaben', { concurrency: 1 }, async () => {
  await requireServer();
  jars ??= await loginAll();

  const TITLE = `Prüftitel ${Date.now()}`;
  const DESCRIPTION = 'Eine eigens gesetzte Beschreibung für den Test.';

  const patchSeo = (jar: string, body: unknown) => call('PATCH', '/api/seo', { jar, body });

  after(async () => {
    await patchSeo(jars.admin, {
      path: '/preise',
      title: '',
      description: '',
      keywords: [],
      ogImageUrl: '',
      noIndex: false,
    });
  });

  it('verwehrt der Betriebsleitung die Pflege', async () => {
    const response = await patchSeo(jars.manager, {
      path: '/preise',
      keywords: [],
      noIndex: false,
    });
    assert.equal(response.status, 403);
  });

  it('schreibt Titel, Beschreibung und Schlüsselwörter ins HTML', async () => {
    const saved = await patchSeo(jars.admin, {
      path: '/preise',
      title: TITLE,
      description: DESCRIPTION,
      keywords: ['Reinigung Bern', 'Preise'],
      noIndex: false,
    });
    assert.equal(saved.status, 200);

    const page = await get('/preise');
    assert.ok(pageTitle(page.text)?.startsWith(TITLE), `Titel ist „${pageTitle(page.text)}"`);
    assert.ok(page.text.includes(DESCRIPTION), 'Beschreibung fehlt');
    assert.ok(page.text.includes('Reinigung Bern'), 'Schlüsselwörter fehlen');
    assert.ok(page.text.includes(`content="${TITLE}"`), 'OpenGraph-Titel fehlt');
  });

  it('setzt bei noIndex ein robots-noindex', async () => {
    const saved = await patchSeo(jars.admin, {
      path: '/preise',
      title: TITLE,
      description: DESCRIPTION,
      keywords: [],
      noIndex: true,
    });
    assert.equal(saved.status, 200);

    const page = await get('/preise');
    assert.match(page.text, /name="robots"[^>]*content="[^"]*noindex/);
  });

  it('weist ein Vorschaubild ohne https oder eigenen Pfad ab (422)', async () => {
    // Vorher `.url()`: `javascript:` und `data:` gingen durch, der Pfad der
    // eigenen Ablage (`/api/files/…`) nicht.
    for (const ogImageUrl of ['javascript:alert(1)', 'data:image/png;base64,AAAA', 'http://fremd.example/x.jpg', '//fremd.example/x.jpg']) {
      const response = await patchSeo(jars.admin, { path: '/preise', keywords: [], noIndex: false, ogImageUrl });
      assert.equal(response.status, 422, ogImageUrl);
    }
    const eigen = await patchSeo(jars.admin, {
      path: '/preise',
      keywords: [],
      noIndex: false,
      ogImageUrl: '/api/files/blob/vorschau.jpg',
    });
    assert.equal(eigen.status, 200);
    const page = await get('/preise');
    assert.match(page.text, /property="og:image" content="https?:\/\/[^"]+\/api\/files\/blob\/vorschau\.jpg"/);
    assert.match(page.text, /name="twitter:card" content="summary_large_image"/);
  });

  it('schreibt Markup in Titel und Beschreibung als Klartext', async () => {
    const saved = await patchSeo(jars.admin, {
      path: '/preise',
      title: `<b>${TITLE}</b>`,
      description: `<i>${DESCRIPTION}</i>`,
      keywords: [],
      noIndex: false,
    });
    assert.equal(saved.status, 200);
    const page = await get('/preise');
    assert.ok(pageTitle(page.text)?.startsWith(TITLE), `Titel ist „${pageTitle(page.text)}"`);
    assert.equal(page.text.includes('&lt;b&gt;'), false, 'Tag als Text im Titel');
    assert.ok(page.text.includes(`content="${DESCRIPTION}"`));
  });

  it('nimmt eine noindex-Seite aus der Sitemap', async () => {
    await patchSeo(jars.admin, { path: '/preise', title: TITLE, keywords: [], noIndex: true });
    const sitemap = (await get('/sitemap.xml')).text;
    assert.equal(/<loc>[^<]*\/preise<\/loc>/.test(sitemap), false, 'noindex-Seite steht in der Sitemap');
  });

  it('stellt nach dem Leeren die Standardangaben wieder her', async () => {
    const saved = await patchSeo(jars.admin, {
      path: '/preise',
      title: '',
      description: '',
      keywords: [],
      ogImageUrl: '',
      noIndex: false,
    });
    assert.equal(saved.status, 200);

    const page = await get('/preise');
    assert.ok(page.text.includes('Preise und Konditionen'), `Titel ist „${pageTitle(page.text)}"`);
    assert.ok(!page.text.includes(TITLE));
    assert.ok(!/name="robots"[^>]*content="[^"]*noindex/.test(page.text), 'noindex blieb stehen');
  });
});

// ---------------------------------------------------------------------------

/**
 * Nebenläufigkeit und Idempotenz der Redaktion (Testmatrix „CMS", 2026-09-27).
 *
 * Die Redaktion arbeitet in der Vorschau: Ein Feld speichert beim Verlassen,
 * ein zweites Fenster ist schnell offen, und „Veröffentlichen" ist ein Knopf,
 * den man zweimal drückt, wenn die Antwort auf sich warten lässt. Was das
 * Produkt dabei zusagt:
 *
 *  • **Gleichzeitige Entwürfe:** Der spätere gewinnt, keiner endet in einem
 *    500, und Entwürfe legen keine Fassung an — die Historie entsteht beim
 *    Veröffentlichen (`content.service.ts`, „Die Historie entsteht beim
 *    Veröffentlichen").
 *  • **Veröffentlichen ohne Änderung** legt keine zweite Fassung und keine
 *    zweite Protokollzeile an. Die Historie beantwortet „was stand vorher auf
 *    der Website?" — eine Fassung, die gleich der geltenden ist, beantwortet
 *    nichts, und eine Zeile „veröffentlicht" für einen unveränderten Text
 *    behauptet eine Freigabe, die es nicht gab.
 *  • **Gleichzeitige Freigaben** desselben Entwurfs: genau eine Fassung und
 *    eine Protokollzeile — je echter Änderung eine.
 *
 * Der Baustein ist `footer.tagline`: Er hat laut `CLAUDE.md` keine Seite, die
 * ihn zeigt, und die übrigen Prüfungen dieser Datei fassen ihn nicht an. Die
 * Zeile wird vorher und nachher entfernt (die Historie hängt per Kaskade
 * daran); Protokollzeilen bleiben stehen, gezählt wird je Baustein-Kennung.
 */
const cmsDb = testDb();
const ohneCmsDb = cmsDb ? false : `kein Zugang zur Testdatenbank: ${testDbGrund()}`;

describe('Redaktion — gleichzeitige Entwürfe, gleichzeitige Freigaben, Freigabe ohne Änderung', { concurrency: 1, skip: ohneCmsDb }, () => {
  const SCHLUESSEL = 'footer.tagline';
  const LAUF = Date.now();
  const s = { org: '' };
  const db = cmsDb!;

  const entwurf = (wert: string) => patchContent(jars.admin, [{ key: SCHLUESSEL, value: wert }]);
  const freigeben = () =>
    call<{ data: { published: number } }>('POST', '/api/content', { jar: jars.admin, body: { action: 'publish', keys: [SCHLUESSEL] } });
  const baustein = () => db.contentBlock.findFirst({ where: { organizationId: s.org, key: SCHLUESSEL, locale: 'DE' } });
  const fassungen = () =>
    db.contentRevision.findMany({ where: { organizationId: s.org, key: SCHLUESSEL }, orderBy: { createdAt: 'asc' }, select: { value: true } });
  const freigabeZeilen = async () => {
    const b = await baustein();
    if (!b) return 0;
    return db.auditLog.count({ where: { entity: 'ContentBlock', entityId: b.id, action: 'UPDATE', summary: { contains: 'veröffentlicht' } } });
  };

  const aufraeumen = async () => {
    // Erst über die Anwendung zurück auf den Auslieferungstext — das leert
    // auch den Inhaltszwischenspeicher —, dann die Zeile samt Historie weg.
    await patchContent(jars.admin, [{ key: SCHLUESSEL, value: '' }]);
    await freigeben();
    await call('POST', '/api/content', { jar: jars.admin, body: { action: 'discard', keys: [SCHLUESSEL] } });
    await db.contentBlock.deleteMany({ where: { organizationId: s.org, key: SCHLUESSEL } });
  };

  before(async () => {
    await requireServer();
    jars ??= await loginAll();
    s.org = (await eigeneOrganisationId()) ?? '';
    assert.ok(s.org, 'die eigene Organisation fehlt — `npm run db:test:setup`?');
    await aufraeumen();
  });

  after(async () => {
    try {
      await aufraeumen();
    } finally {
      await testDbSchliessen();
    }
  });

  it('sechs gleichzeitige Entwürfe eines noch nie gespeicherten Bausteins: kein 500, eine Zeile, einer der Entwürfe gilt, keine Fassung', async () => {
    assert.equal(await baustein(), null, 'Vorbedingung: der Baustein hat noch keine Zeile');
    const werte = Array.from({ length: 6 }, (_, i) => `Gleichzeitig ${LAUF} Nr. ${i}`);
    const antworten = await Promise.all(werte.map((w) => entwurf(w)));
    assert.deepEqual(
      antworten.map((a) => a.status),
      werte.map(() => 200),
      `gleichzeitiges Speichern: ${antworten.map((a) => `${a.status} ${a.text.slice(0, 120)}`).join(' | ')}`,
    );

    const zeilen = await db.contentBlock.findMany({ where: { organizationId: s.org, key: SCHLUESSEL, locale: 'DE' } });
    assert.equal(zeilen.length, 1, 'mehr als eine Zeile für denselben Baustein');
    assert.ok(werte.includes(zeilen[0]!.draftValue as string), `der Entwurf ist keiner der gesendeten: ${JSON.stringify(zeilen[0]!.draftValue)}`);
    assert.equal(zeilen[0]!.publishedAt, null, 'Speichern hat veröffentlicht');
    assert.equal((await fassungen()).length, 0, 'ein Entwurf hat eine Fassung angelegt');
  });

  it('gleichzeitige Entwürfe eines veröffentlichten Bausteins: keine Fassung geht verloren, keine entsteht zu viel', async () => {
    const erste = await freigeben();
    assert.equal(erste.status, 200, erste.text);
    assert.equal(data(erste).published, 1);
    const erstVeroeffentlicht = (await baustein())!.value;
    assert.equal((await fassungen()).length, 0, 'die erste Freigabe hat nichts abzulösen');

    const zweiterWortlaut = `Veröffentlicht ${LAUF}`;
    assert.equal((await entwurf(zweiterWortlaut)).status, 200);
    assert.equal(data(await freigeben()).published, 1);

    const werte = Array.from({ length: 6 }, (_, i) => `Überarbeitung ${LAUF} Nr. ${i}`);
    const antworten = await Promise.all(werte.map((w) => entwurf(w)));
    assert.ok(antworten.every((a) => a.status === 200), antworten.map((a) => `${a.status} ${a.text.slice(0, 120)}`).join(' | '));
    const zwischen = (await baustein())!;
    assert.equal(zwischen.value, zweiterWortlaut, 'ein Entwurf hat den veröffentlichten Text ersetzt');
    assert.ok(werte.includes(zwischen.draftValue as string), `Entwurf: ${JSON.stringify(zwischen.draftValue)}`);

    const dritte = await freigeben();
    assert.equal(data(dritte).published, 1);
    const historie = (await fassungen()).map((f) => f.value);
    assert.deepEqual(historie, [erstVeroeffentlicht, zweiterWortlaut], `Historie: ${JSON.stringify(historie)}`);
  });

  it('zweimal veröffentlichen ohne Änderung: keine zweite Fassung, keine zweite Protokollzeile', async () => {
    const vorher = { fassungen: (await fassungen()).length, zeilen: await freigabeZeilen(), block: (await baustein())! };

    // Ohne offenen Entwurf: nichts zu tun.
    const leer = await freigeben();
    assert.equal(leer.status, 200, leer.text);
    assert.equal(data(leer).published, 0);

    // Der Entwurf trägt den veröffentlichten Wortlaut — so speichert die
    // Vorschau, wenn jemand in ein Feld klickt und es wieder verlässt.
    assert.equal((await entwurf(vorher.block.value as string)).status, 200);
    const unveraendert = await freigeben();
    assert.equal(unveraendert.status, 200, unveraendert.text);
    assert.equal(data(unveraendert).published, 0, 'ein unveränderter Text wurde als Veröffentlichung gezählt');

    assert.equal((await fassungen()).length, vorher.fassungen, 'eine Freigabe ohne Änderung hat eine Fassung angelegt');
    assert.equal(await freigabeZeilen(), vorher.zeilen, 'eine Freigabe ohne Änderung hat eine Protokollzeile „veröffentlicht" geschrieben');
    const nachher = (await baustein())!;
    assert.equal(nachher.draftValue, null, 'der Entwurf ohne Änderung bleibt als offener Entwurf stehen');
    assert.equal(nachher.publishedAt?.getTime(), vorher.block.publishedAt?.getTime(), 'der Veröffentlichungszeitpunkt hat sich ohne Änderung verschoben');
  });

  it('fünf gleichzeitige Freigaben desselben Entwurfs: genau eine Fassung und eine Protokollzeile', async () => {
    const vorher = { fassungen: (await fassungen()).length, zeilen: await freigabeZeilen(), wert: (await baustein())!.value };
    const neu = `Gleichzeitig freigegeben ${LAUF}`;
    assert.equal((await entwurf(neu)).status, 200);

    const antworten = await Promise.all(Array.from({ length: 5 }, () => freigeben()));
    assert.ok(antworten.every((a) => a.status === 200), antworten.map((a) => `${a.status} ${a.text.slice(0, 120)}`).join(' | '));
    const summe = antworten.reduce((n, a) => n + (data(a)?.published ?? 0), 0);
    assert.equal(summe, 1, `derselbe Entwurf wurde ${summe}-mal veröffentlicht`);

    const historie = (await fassungen()).map((f) => f.value);
    assert.equal(historie.length, vorher.fassungen + 1, `Fassungen: ${JSON.stringify(historie)}`);
    assert.equal(historie.at(-1), vorher.wert, 'die neue Fassung ist nicht der abgelöste Text');
    assert.equal(await freigabeZeilen(), vorher.zeilen + 1, 'mehr als eine Protokollzeile für eine Freigabe');
    const block = (await baustein())!;
    assert.equal(block.value, neu);
    assert.equal(block.draftValue, null);
  });
});
