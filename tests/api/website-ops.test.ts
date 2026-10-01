import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { call, del, get, patch, post, put, requireServer, sleep } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';

/**
 * Die Website- und Betriebsbereiche: Fragen, Galerie, Navigation, Rechtstexte,
 * Einsatzgebiet, Stellenangebote, Automatisierungen, Firmendaten.
 *
 * Der Schwerpunkt liegt auf den Fachregeln. Dass ein Endpunkt antwortet, sagt
 * wenig; interessant ist, ob eine Regel greift, wenn sie greifen soll — ob die
 * Galerie ein zweimal dasselbe Bild ablehnt, ob ein Menüpunkt sein Elternteil
 * im richtigen Bereich verlangt, ob eine IBAN geprüft wird.
 *
 * Alles, was hier entsteht, wird am Ende wieder entfernt. Und alles, was ein
 * abgebrochener früherer Lauf hinterlassen haben könnte, wird vorher
 * weggeräumt: Ein 409 „gibt es schon" sagt nichts über das Produkt.
 */

const REJECTED = [400, 422];
const rejected = (status: number) => REJECTED.includes(status);

let jars: Record<AccountName, string>;
const cleanup: string[] = [];

describe('Website- und Betriebsbereiche', { concurrency: 1 }, async () => {
  await requireServer();
  jars = await loginAll();

  after(async () => {
    for (const path of cleanup) {
      await del(path, { jar: jars.admin });
    }
    await testDbSchliessen();
  });

  // -------------------------------------------------------------------------
  describe('Erreichbarkeit', () => {
    /**
     * Die Betriebsleitung darf lesen, Mitarbeitende nicht. Die Grenze verläuft
     * dort, weil Disposition den Kontext braucht — Öffnungszeiten,
     * Einsatzgebiet, Vorlagen —, eine Reinigungskraft im Portal aber nicht.
     */
    const ENDPOINTS = [
      '/api/faq',
      '/api/gallery',
      '/api/navigation',
      '/api/legal',
      '/api/service-areas',
      '/api/job-postings',
      '/api/automations',
      '/api/templates',
      '/api/company',
      '/api/newsletter',
    ];

    for (const path of ENDPOINTS) {
      it(`${path}: Verwaltung liest, Mitarbeitende nicht`, async () => {
        assert.equal((await get(path, { jar: jars.admin })).status, 200, 'admin');
        assert.equal((await get(path, { jar: jars.manager })).status, 200, 'manager');
        assert.equal((await get(path, { jar: jars.employee })).status, 403, 'employee');
      });
    }
  });

  // -------------------------------------------------------------------------
  describe('Häufige Fragen', () => {
    it('legt eine Frage an und zeigt sie auf /faq', async () => {
      const create = await post<{ data: { id: string } }>(
        '/api/faq',
        {
          question: 'Prüffrage aus dem Testlauf?',
          answer:
            'Diese Antwort entsteht in einer automatisierten Prüfung und wird danach entfernt.',
          category: 'Prüfung',
        },
        { jar: jars.admin },
      );
      assert.equal(create.status, 201);
      cleanup.push(`/api/faq/${create.payload.data.id}`);

      await sleep(400);
      const page = await get('/faq');
      assert.ok(
        page.text.includes('Prüffrage aus dem Testlauf'),
        'die neue Frage steht nicht auf der Seite — greift revalidatePath?',
      );
    });

    it('weist eine zu kurze Antwort ab', async () => {
      // „Ja." beantwortet nichts und beschäftigt den Support danach doppelt.
      const response = await post(
        '/api/faq',
        { question: 'Zu kurz?', answer: 'Ja.' },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Galerie', () => {
    it('weist dasselbe Bild für vorher und nachher ab', async () => {
      // Ein Vorher-Nachher ohne Unterschied ist eine Falschaussage.
      const response = await post(
        '/api/gallery',
        {
          title: 'Prüfeintrag',
          beforeUrl: 'https://example.com/a.jpg',
          afterUrl: 'https://example.com/a.jpg',
        },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('weist ein Bild über http ab', async () => {
      // Ein unverschlüsseltes Bild macht die ganze Seite unsicher.
      const response = await post(
        '/api/gallery',
        {
          title: 'Prüfeintrag',
          beforeUrl: 'http://example.com/a.jpg',
          afterUrl: 'https://example.com/b.jpg',
        },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('nimmt einen gültigen Eintrag an', async () => {
      const response = await post<{ data: { id: string } }>(
        '/api/gallery',
        {
          title: 'Prüfeintrag Galerie',
          beforeUrl: 'https://example.com/vorher.jpg',
          afterUrl: 'https://example.com/nachher.jpg',
          published: false,
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201);
      cleanup.push(`/api/gallery/${response.payload.data.id}`);
    });

    /*
      Ein veröffentlichter Eintrag auf der Website (2026-09-30): sein
      Alternativtext und die Seiten, die ihn zeigen.

      Bis dahin hiessen die Bilder im `alt` nur „Vorher"/„Nachher", und eine
      Änderung an der Galerie erneuerte `/galerie` und die Startseite, nicht
      aber die Leistungsseiten — die zeigen den ersten veröffentlichten
      Eintrag ihrer Art und blieben bis zu einer Stunde beim alten Stand,
      auch nach dem Zurückziehen eines Fotos. Beide Fälle wären gegen diesen
      Stand rot.

      Nicht hervorgehoben (`featured: false`), damit die Startseite unberührt
      bleibt; Bilder nur über https (das Schema lehnt http ab). Was ein
      abgebrochener Lauf hinterlassen hat, wird vorher an der Titelmarke
      erkannt und gelöscht.
    */
    describe('veröffentlichter Eintrag auf der Website', () => {
      const MARKE = 'Prüfvergleich';
      const titel = `${MARKE} ${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
      const ort = 'Bern Prüfquartier';
      // Die Beschriftungen der Galerie für die Art eines Eintrags — so steht
      // es neben dem Bild und im Alternativtext (`galerie/page.tsx`).
      const ART_BESCHRIFTUNG: Record<string, string> = {
        RESIDENTIAL_CLEANING: 'Unterhaltsreinigung',
        MOVE_OUT_CLEANING: 'Umzugsreinigung',
        OFFICE_CLEANING: 'Büroreinigung',
        WINDOW_CLEANING: 'Fensterreinigung',
        CONSTRUCTION_CLEANING: 'Baureinigung',
        BUILDING_MAINTENANCE: 'Hauswartung',
        SPECIAL: 'Spezialauftrag',
      };
      let leistung: { slug: string; name: string; kind: string } | undefined;
      let eintragId = '';

      /**
       * Der Alternativtext des `<img>` mit dieser Bildadresse, mit
       * aufgelösten Entitäten — ein Leistungsname wie „Hauswartung &
       * Liegenschaftsbetreuung" steht im Attribut als `&amp;`.
       */
      const altVon = (html: string, src: string) => {
        const tag = [...html.matchAll(/<img\b[^>]*>/g)].map((t) => t[0]).find((t) => t.includes(`src="${src}"`));
        const roh = tag ? /\balt="([^"]*)"/.exec(tag)?.[1] : undefined;
        if (roh === undefined) return null;
        return roh
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, '&');
      };

      it('räumt Reste eines abgebrochenen Laufs weg und wählt eine Leistung', async () => {
        const liste = await get<{ data: Array<{ id: string; title: string }> }>('/api/gallery', { jar: jars.admin });
        assert.equal(liste.status, 200);
        for (const rest of liste.payload.data.filter((e) => e.title.startsWith(MARKE))) {
          await del(`/api/gallery/${rest.id}`, { jar: jars.admin });
        }

        const leistungen = await get<{ data: Array<{ slug: string; name: string; kind: string; active: boolean }> }>(
          '/api/services',
          { jar: jars.admin },
        );
        assert.equal(leistungen.status, 200);
        leistung = leistungen.payload.data.find((l) => l.active && l.kind in ART_BESCHRIFTUNG);
        assert.ok(leistung, 'keine aktive Leistung im Katalog');

        // Die Leistungsseite einmal aufrufen, bevor es den Eintrag gibt: Ab
        // jetzt liegt sie im Zwischenspeicher, und nur eine Erneuerung bringt
        // den Eintrag darauf.
        const vorher = await get(`/leistungen/${leistung.slug}`);
        assert.equal(vorher.status, 200);
        assert.ok(!vorher.text.includes(titel));
      });

      it('veröffentlichter Galerieeintrag: /galerie nennt ihn im alt beider Bilder', async () => {
        assert.ok(leistung, 'Vorbereitung fehlgeschlagen');
        const angelegt = await post<{ data: { id: string } }>(
          '/api/gallery',
          {
            title: titel,
            serviceKind: leistung.kind,
            location: ort,
            beforeUrl: 'https://example.com/pruefvergleich-vorher.jpg',
            afterUrl: 'https://example.com/pruefvergleich-nachher.jpg',
            featured: false,
            position: 0,
            published: true,
          },
          { jar: jars.admin },
        );
        assert.equal(angelegt.status, 201, angelegt.text);
        eintragId = angelegt.payload.data.id;
        cleanup.push(`/api/gallery/${eintragId}`);

        await sleep(600);
        const html = (await get('/galerie')).text;
        const beschreibung = `${titel}, ${ART_BESCHRIFTUNG[leistung.kind]}, ${ort}`;
        assert.equal(altVon(html, 'https://example.com/pruefvergleich-vorher.jpg'), `Vorher: ${beschreibung}`);
        assert.equal(altVon(html, 'https://example.com/pruefvergleich-nachher.jpg'), `Nachher: ${beschreibung}`);
      });

      it('eine Galerieänderung erneuert auch die Leistungsseiten', async () => {
        assert.ok(leistung && eintragId, 'Vorbereitung fehlgeschlagen');
        const pfad = `/leistungen/${leistung.slug}`;

        // Angelegt: Die Leistungsseite zeigt den Eintrag — mit Alternativtext
        // aus Titel, dem Namen dieser Leistung und dem Ort.
        const nachAnlegen = (await get(pfad)).text;
        assert.equal(
          altVon(nachAnlegen, 'https://example.com/pruefvergleich-vorher.jpg'),
          `Vorher: ${titel}, ${leistung.name}, ${ort}`,
          'die Leistungsseite zeigt den neuen Eintrag nicht — wird sie erneuert?',
        );

        // Geändert: der neue Titel, nicht mehr der alte.
        const neuerTitel = `${titel} geaendert`;
        const geaendert = await patch(`/api/gallery/${eintragId}`, { title: neuerTitel }, { jar: jars.admin });
        assert.equal(geaendert.status, 200, geaendert.text);
        await sleep(600);
        const nachAendern = (await get(pfad)).text;
        assert.ok(nachAendern.includes(neuerTitel), 'die Änderung erreicht die Leistungsseite nicht');

        // Zurückgezogen: Das Foto verschwindet sofort, nicht erst nach einer Stunde.
        const zurueck = await patch(`/api/gallery/${eintragId}`, { published: false }, { jar: jars.admin });
        assert.equal(zurueck.status, 200, zurueck.text);
        await sleep(600);
        const nachZurueckziehen = (await get(pfad)).text;
        assert.ok(!nachZurueckziehen.includes(titel), 'ein zurückgezogener Eintrag steht noch auf der Leistungsseite');
        assert.equal(altVon(nachZurueckziehen, 'https://example.com/pruefvergleich-vorher.jpg'), null);
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('Navigation', () => {
    interface NavItem {
      id: string;
      label: string;
      location: string;
      parentId: string | null;
    }

    let header: NavItem | undefined;

    it('führt ein gefülltes Menü', async () => {
      const nav = await get<{ data: NavItem[] }>('/api/navigation', { jar: jars.admin });
      assert.ok(nav.payload.data.length > 10, `nur ${nav.payload.data.length} Punkte`);
      header = nav.payload.data.find((item) => item.location === 'HEADER' && !item.parentId);
      assert.ok(header, 'kein Punkt der obersten Kopfzeilenebene');
    });

    it('weist einen Aufklapp-Punkt ohne Elternteil ab', async () => {
      // Er wäre im Menü nicht erreichbar und stünde nur in der Datenbank.
      const response = await post(
        '/api/navigation',
        { location: 'HEADER_PANEL', label: 'Waise', href: '/test' },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('weist ein Elternteil aus dem falschen Bereich ab', async () => {
      const response = await post(
        '/api/navigation',
        {
          location: 'FOOTER_COMPANY',
          label: 'Falsch',
          href: '/test',
          parentId: header?.id,
        },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('weist ein protokollrelatives Ziel ab', async () => {
      // `//fremde-seite.example` sieht aus wie ein Pfad und führt nach draussen.
      const response = await post(
        '/api/navigation',
        { location: 'FOOTER_COMPANY', label: 'Böse', href: '//fremde-seite.example' },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('nimmt einen gültigen Punkt an', async () => {
      const response = await post<{ data: { id: string } }>(
        '/api/navigation',
        { location: 'FOOTER_COMPANY', label: 'Prüfpunkt', href: '/faq', active: false },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201);
      cleanup.push(`/api/navigation/${response.payload.data.id}`);
    });

    it('zeigt das Kopfzeilenmenü auf der Website', async () => {
      assert.ok(header);
      const home = await get('/');
      assert.ok(home.text.includes(header.label), `„${header.label}" fehlt im HTML`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Rechtstexte', () => {
    const body = 'Dies ist ein Prüftext für die automatisierte Kontrolle. '.repeat(4);
    let baseline = 0;

    it('führt genau vier Dokumente', async () => {
      // Impressum, Datenschutz, AGB, Cookies — die Liste ist geschlossen,
      // weil jedes davon eine eigene Route auf der Website hat.
      const list = await get<{ data: unknown[] }>('/api/legal', { jar: jars.admin });
      assert.equal(list.payload.data.length, 4);
    });

    it('weist einen zu kurzen Text ab', async () => {
      const response = await put(
        '/api/legal/impressum',
        { title: 'Impressum', body: 'Zu kurz.', effectiveFrom: '2026-01-01' },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('lässt die Fassung beim Speichern ohne Häkchen stehen', async () => {
      /**
       * Relativ zur bestehenden Fassung geprüft, nicht absolut. Der Test läuft
       * mehrfach gegen dieselbe Datenbank; eine Erwartung auf „Fassung 1" wäre
       * beim zweiten Lauf falsch, ohne dass am Produkt etwas kaputt wäre.
       */
      const before = await get<{ data: { version: number } }>('/api/legal/agb', {
        jar: jars.admin,
      });
      const previous = before.payload?.data?.version ?? 0;

      const saved = await put<{ data: { version: number } }>(
        '/api/legal/agb',
        { title: 'AGB (Prüfung)', body, effectiveFrom: '2026-01-01', newVersion: false },
        { jar: jars.admin },
      );
      assert.equal(saved.status, 200);
      baseline = saved.payload.data.version;
      assert.equal(baseline, Math.max(previous, 1), `vorher ${previous}, jetzt ${baseline}`);

      const again = await put<{ data: { version: number } }>(
        '/api/legal/agb',
        {
          title: 'AGB (Prüfung)',
          body: `${body}Ein Tippfehler korrigiert.`,
          effectiveFrom: '2026-01-01',
          newVersion: false,
        },
        { jar: jars.admin },
      );
      assert.equal(again.payload.data.version, baseline, 'ein Tippfehler ist keine neue Fassung');
    });

    it('zählt die Fassung mit Häkchen um genau eins hoch', async () => {
      const bumped = await put<{ data: { version: number } }>(
        '/api/legal/agb',
        {
          title: 'AGB (Prüfung)',
          body: `${body}Inhaltlich geändert.`,
          effectiveFrom: '2026-02-01',
          newVersion: true,
        },
        { jar: jars.admin },
      );
      assert.equal(bumped.payload.data.version, baseline + 1);

      await sleep(600);
      const page = await get('/legal/agb');
      assert.ok(page.text.includes('Prüftext für die automatisierte Kontrolle'), 'Text fehlt');
      assert.ok(page.text.includes('in Kraft seit'), 'kein Fassungsblock');
      // React setzt beim Serverrendern `<!-- -->` zwischen statischen Text und
      // eingesetzte Werte: `Fassung 4` steht im HTML als `Fassung <!-- -->4`.
      assert.match(
        page.text,
        new RegExp(`Fassung\\s*(?:<!--\\s*-->)?\\s*${baseline + 1}`),
        `Fassung ${baseline + 1} nicht im HTML`,
      );
    });

    it('weist einen unbekannten Rechtstext ab', async () => {
      const response = await put(
        '/api/legal/erfundenes',
        { title: 'X', body, effectiveFrom: '2026-01-01' },
        { jar: jars.admin },
      );
      assert.ok([404, 422].includes(response.status), `HTTP ${response.status}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Einsatzgebiet', () => {
    interface Area {
      id: string;
      postalCode: string;
    }

    const TEST_CODES = ['3998', '3999'];
    let createdId = '';

    const purgeTestAreas = async () => {
      const list = await get<{ data: Area[] }>('/api/service-areas', { jar: jars.admin });
      for (const area of list.payload.data.filter((a) => TEST_CODES.includes(a.postalCode))) {
        await del(`/api/service-areas/${area.id}`, { jar: jars.admin });
      }
    };

    it('räumt Reste eines abgebrochenen Laufs weg', async () => {
      await purgeTestAreas();
      assert.ok(true);
    });

    it('legt ein Gebiet an', async () => {
      const response = await post<{ data: { id: string } }>(
        '/api/service-areas',
        { postalCode: '3999', city: 'Prüfhausen', travelFee: 25, travelMinutes: 30 },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201);
      createdId = response.payload.data.id;
    });

    it('weist eine doppelte Postleitzahl mit 409 ab', async () => {
      const response = await post(
        '/api/service-areas',
        { postalCode: '3999', city: 'Nochmal' },
        { jar: jars.admin },
      );
      assert.equal(response.status, 409);
    });

    it('weist eine ungültige Postleitzahl ab', async () => {
      const response = await post(
        '/api/service-areas',
        { postalCode: '99', city: 'X' },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('überspringt bei der Sammelaufnahme, was es schon gibt', async () => {
      // Überschreiben wäre die gefährlichere Voreinstellung: Eine hochgeladene
      // Liste würde stillschweigend gepflegte Anfahrtspauschalen ersetzen.
      const response = await post<{ data: { created: number; skipped: number } }>(
        '/api/service-areas/bulk',
        {
          areas: [
            { postalCode: '3998', city: 'Prüfdorf', travelFee: 20, travelMinutes: 25 },
            { postalCode: '3999', city: 'Überschrieben', travelFee: 99, travelMinutes: 99 },
          ],
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 200);
      assert.equal(response.payload.data.created, 1);
      assert.equal(response.payload.data.skipped, 1);
    });

    it('löscht ein Gebiet ohne Einsätze', async () => {
      const response = await del(`/api/service-areas/${createdId}`, { jar: jars.admin });
      assert.equal(response.status, 204);
      await purgeTestAreas();
    });
  });

  // -------------------------------------------------------------------------
  describe('Stellenangebote', () => {
    interface Posting {
      id: string;
      slug: string;
      _count?: { applications: number };
    }

    const SLUG = 'pruefstelle-testlauf';

    it('räumt Reste eines abgebrochenen Laufs weg', async () => {
      const list = await get<{ data: Posting[] }>('/api/job-postings', { jar: jars.admin });
      for (const posting of list.payload.data.filter((p) => p.slug === SLUG)) {
        await del(`/api/job-postings/${posting.id}`, { jar: jars.admin });
      }
      assert.ok(true);
    });

    /**
     * Die Bewerbungen hingen sonst im Nichts — und ihre Daten unterliegen
     * einer Aufbewahrungsfrist.
     *
     * Bis Wave 23 suchte der Fall ein Angebot mit Bewerbungen im Demobestand
     * und übersprang sich, wenn keines da war — in jedem vollen Lauf der eine
     * `skip` der Reihe, und damit eine Regel, die nie geprüft wurde. Jetzt legt
     * er Angebot und Bewerbung selbst an: das Angebot über die API (derselbe
     * Weg wie in der Verwaltung), die Bewerbung direkt in der Datenbank, weil
     * es hier um die Löschsperre geht und nicht um das Bewerbungsformular.
     */
    it('löscht kein Angebot mit Bewerbungen', async () => {
      const db = testDb();
      assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
      const organizationId = await eigeneOrganisationId();
      assert.ok(organizationId);
      const slug = 'pruefstelle-mit-bewerbung';

      // Reste eines abgebrochenen Laufs: erst die Bewerbungen, dann das Angebot.
      await db.jobApplication.deleteMany({ where: { posting: { organizationId, slug } } });
      await db.jobPosting.deleteMany({ where: { organizationId, slug } });

      const angelegt = await post<{ data: Posting }>(
        '/api/job-postings',
        {
          title: 'Prüfstelle mit Bewerbung',
          slug,
          description:
            'Eine Stellenausschreibung, die nur während einer automatisierten Prüfung besteht und danach entfernt wird.',
          workloadFrom: 50,
          workloadTo: 80,
        },
        { jar: jars.admin },
      );
      assert.equal(angelegt.status, 201, JSON.stringify(angelegt.payload));
      const postingId = angelegt.payload.data.id;

      try {
        await db.jobApplication.create({
          data: { postingId, firstName: 'Prüf', lastName: 'Bewerbung', email: 'pruef.bewerbung@example.ch' },
        });

        const response = await del(`/api/job-postings/${postingId}`, { jar: jars.admin });
        assert.equal(response.status, 422);
        assert.ok(await db.jobPosting.findUnique({ where: { id: postingId } }), 'Angebot trotz 422 gelöscht');

        // Die Gegenprobe: Ohne Bewerbung geht es — die Sperre hängt an den
        // Bewerbungen, nicht am Angebot.
        await db.jobApplication.deleteMany({ where: { postingId } });
        assert.equal((await del(`/api/job-postings/${postingId}`, { jar: jars.admin })).status, 204);
      } finally {
        await db.jobApplication.deleteMany({ where: { postingId } });
        await db.jobPosting.deleteMany({ where: { id: postingId } });
      }
    });

    it('weist ein Pensum von 100 bis 50 ab', async () => {
      const response = await post(
        '/api/job-postings',
        {
          title: 'Prüfstelle',
          slug: SLUG,
          description:
            'Eine Stellenausschreibung, die nur während einer automatisierten Prüfung besteht und danach entfernt wird.',
          workloadFrom: 100,
          workloadTo: 50,
        },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('nimmt eine gültige Ausschreibung an', async () => {
      const response = await post<{ data: { id: string } }>(
        '/api/job-postings',
        {
          title: 'Prüfstelle',
          slug: SLUG,
          description:
            'Eine Stellenausschreibung, die nur während einer automatisierten Prüfung besteht und danach entfernt wird.',
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201);
      cleanup.push(`/api/job-postings/${response.payload.data.id}`);
    });
  });

  // -------------------------------------------------------------------------
  describe('Automatisierungen', () => {
    it('weist eine Regel ohne Aktion ab', async () => {
      // Sie stünde in der Liste, sähe scharf aus und täte nichts.
      const response = await post(
        '/api/automations',
        { name: 'Prüfregel ohne Aktion', trigger: 'BOOKING_CREATED', actions: [] },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('weist eine Verzögerung vor einem vergangenen Ereignis ab', async () => {
      // „Eine Stunde vor der Rechnungsstellung" liegt in der Vergangenheit,
      // sobald die Rechnung gestellt ist — die Regel liefe nie.
      const response = await post(
        '/api/automations',
        {
          name: 'Prüfregel rückwärts',
          trigger: 'INVOICE_ISSUED',
          delayMinutes: -60,
          actions: [{ type: 'SEND_EMAIL', config: {} }],
        },
        { jar: jars.admin },
      );
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('nimmt eine gültige Regel an', async () => {
      // Vor einem *künftigen* Ereignis ist eine negative Verzögerung sinnvoll.
      const response = await post<{ data: { id: string } }>(
        '/api/automations',
        {
          name: 'Prüfregel gültig',
          trigger: 'BOOKING_REMINDER_24H',
          delayMinutes: -60,
          actions: [{ type: 'SEND_EMAIL', config: { templateKey: 'booking_reminder' } }],
          active: false,
        },
        { jar: jars.admin },
      );
      assert.equal(response.status, 201);
      cleanup.push(`/api/automations/${response.payload.data.id}`);
    });

    it('löscht keine Regel mit Laufhistorie', async (t) => {
      const list = await get<{ data: { id: string; _count?: { runs: number } }[] }>(
        '/api/automations',
        { jar: jars.admin },
      );
      const withRuns = list.payload.data.find((rule) => (rule._count?.runs ?? 0) > 0);

      if (!withRuns) {
        t.skip('keine Regel mit Laufhistorie im Bestand');
        return;
      }

      assert.equal((await del(`/api/automations/${withRuns.id}`, { jar: jars.admin })).status, 422);
    });
  });

  // -------------------------------------------------------------------------
  describe('Firmendaten', () => {
    interface Company {
      name: string;
      iban?: string | null;
    }

    let company: Company;

    it('liest die Firmendaten', async () => {
      const response = await get<{ data: Company }>('/api/company', { jar: jars.admin });
      assert.equal(response.status, 200);
      assert.ok(response.payload.data?.name, 'kein Firmenname');
      company = response.payload.data;
    });

    it('weist eine IBAN mit falscher Prüfsumme ab', async () => {
      // Eine falsche IBAN auf einer Rechnung führt zu Zahlungen, die nie
      // ankommen — die Prüfsumme nach ISO 13616 fängt genau das ab.
      const response = await call('PATCH', '/api/company', {
        jar: jars.admin,
        body: { ...company, iban: 'CH0000000000000000000' },
      });
      assert.ok(rejected(response.status), `HTTP ${response.status}`);
    });

    it('nimmt eine gültige IBAN an', async () => {
      const response = await call('PATCH', '/api/company', {
        jar: jars.admin,
        body: { ...company, iban: 'CH9300762011623852957' },
      });
      assert.equal(response.status, 200);

      await call('PATCH', '/api/company', {
        jar: jars.admin,
        body: { ...company, iban: company.iban ?? '' },
      });
    });

    it('weist Öffnungszeiten ab, die vor dem Öffnen schliessen', async () => {
      const response = await put(
        '/api/opening-hours',
        { hours: [{ weekday: 1, opensAt: '18:00', closesAt: '08:00', closed: false }] },
        { jar: jars.admin },
      );
      assert.equal(response.status, 422);
    });
  });
});
