import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, get, requireServer } from '../helpers/client';
import { loginAll, ROLE_ORDER, type AccountName } from '../helpers/accounts';
import { pageTitle } from '../helpers/markup';

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

  describe('Die Redaktionsmaske selbst', () => {
    /**
     * `/admin/inhalte` ist eine reine Bearbeitungsmaske ohne Lesemodus. Sie
     * hängt deshalb an `content:update`, nicht an einem Leserecht — wer nichts
     * ändern darf, hat dort nichts zu sehen.
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
        const visible = response.status === 200 && response.text.includes('Überschrift, erste Zeile');

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
