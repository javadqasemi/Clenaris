import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  pfadBereinigen,
  referrerHost,
  siehtNachTokenAus,
  umgebungAusUserAgent,
  utmWert,
  verfolgungAbgelehnt,
} from '../../src/lib/traffic/bereinigen';
import { sitzungsHash } from '../../src/lib/traffic/sitzung';
import { aufbewahrungsgrenze, trafficZeitraumAufloesen } from '../../src/lib/traffic/zeitraum';
import { TRAFFIC_BROWSER, TRAFFIC_EREIGNISSE, TRAFFIC_GERAETE } from '../../src/lib/traffic/ereignisse';

/**
 * Rechenkern der eigenen Besuchsmessung (2026-09-28) — direkt importiert,
 * ohne Server.
 *
 * Die Bereinigung ist das Herz der Datenschutzaussage: Was hier durchgeht,
 * steht in einer Tabelle, die das Marketing liest. Deshalb Fall für Fall
 * belegt — besonders die Tokenpfade, deren Durchlass ein Zugang zu fremden
 * Offerten, Rechnungen und Buchungen wäre.
 */

const tag = (text: string) => new Date(`${text}T00:00:00.000Z`);
const text = (d: Date) => d.toISOString().slice(0, 10);

describe('Besuchsmessung — Pfadbereinigung', () => {
  it('lässt einen gewöhnlichen Pfad unverändert (klein, ohne Schrägstrich am Ende)', () => {
    assert.deepEqual(pfadBereinigen('/leistungen/umzugsreinigung/'), {
      pfad: '/leistungen/umzugsreinigung',
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
    });
    assert.equal(pfadBereinigen('/')?.pfad, '/');
    assert.equal(pfadBereinigen('/Kontakt')?.pfad, '/kontakt');
  });

  it('entfernt die Abfrage vollständig und hebt nur utm_* in eigene Felder', () => {
    const r = pfadBereinigen('/buchen/bestaetigt?nr=BK-2026-0001&t=abc123SECRET&utm_source=Google&utm_medium=CPC&utm_campaign=Herbst%202026');
    assert.equal(r?.pfad, '/buchen/bestaetigt');
    assert.equal(r?.utmSource, 'google');
    assert.equal(r?.utmMedium, 'cpc');
    assert.equal(r?.utmCampaign, 'herbst 2026');
  });

  it('entfernt das Fragment', () => {
    assert.equal(pfadBereinigen('/signatur#token=geheim')?.pfad, '/signatur');
  });

  it('maskiert das Token-Segment der Capability-Links, egal wie es aussieht', () => {
    assert.equal(pfadBereinigen('/offerte/kurz')?.pfad, '/offerte/:token');
    assert.equal(pfadBereinigen('/rechnung/AbCdEf0123456789xyzABCDEFghijk_-12345678')?.pfad, '/rechnung/:token');
    assert.equal(pfadBereinigen('/buchung/c1a2b3c4d5e6f7g8h9i0j1k2l')?.pfad, '/buchung/:token');
    assert.equal(pfadBereinigen('/rechnung/x/pdf')?.pfad, '/rechnung/:token/pdf');
  });

  it('maskiert token-artige Segmente auch ausserhalb bekannter Routen', () => {
    // Base64url (43 Zeichen), cuid, UUID, lange Ziffernfolge, E-Mail-Adresse
    assert.equal(pfadBereinigen('/x/q2Xv8mD1sP0aLr7Tb9Kc3Wn5Hy4Ze6Gf1Jd2Uk8Ro0M')?.pfad, '/x/:token');
    assert.equal(pfadBereinigen('/x/clx9f3k2p0000abcd1234efgh')?.pfad, '/x/:token');
    assert.equal(pfadBereinigen('/x/550e8400-e29b-41d4-a716-446655440000')?.pfad, '/x/:token');
    assert.equal(pfadBereinigen('/x/0791234567')?.pfad, '/x/:token');
    assert.equal(pfadBereinigen('/x/anna%40example.ch')?.pfad, '/x/:token');
  });

  it('lässt sprechende Slugs stehen', () => {
    assert.equal(pfadBereinigen('/blog/fruehlingsputz-checkliste-2026')?.pfad, '/blog/fruehlingsputz-checkliste-2026');
    assert.equal(pfadBereinigen('/leistungen/bueroreinigung')?.pfad, '/leistungen/bueroreinigung');
    // 33 Zeichen, aber sprechend: ein Blogbeitrag aus dem Demobestand.
    assert.equal(pfadBereinigen('/blog/reinigungsmittel-richtig-dosieren')?.pfad, '/blog/reinigungsmittel-richtig-dosieren');
    assert.equal(siehtNachTokenAus('umzugsreinigung-bern'), false);
    // Über 32 Zeichen ohne Wortstruktur bleibt es ein Token — auch klein geschrieben.
    assert.equal(siehtNachTokenAus('abcdefghijklmnopqrstuvwxyzabcdefgh'), true);
    assert.equal(siehtNachTokenAus('a'.repeat(81)), true);
    assert.equal(siehtNachTokenAus(`wort-${'x'.repeat(30)}`), true, 'ein Teil über 24 Zeichen');
  });

  it('verwirft jeden App-Bereich ganz — segmentgenau', () => {
    for (const pfad of [
      '/admin',
      '/admin/kunden/abc',
      '/portal/einsaetze',
      '/konto',
      '/api/public/traffic',
      '/auth/passwort-neu?token=x',
      '/auth/anmelden',
      '/signieren/abc',
      '/abnahme/123',
      '/geraet-uebernehmen',
      '/_next/static/chunk.js',
      '/ADMIN/Kunden',
    ]) {
      assert.equal(pfadBereinigen(pfad), null, pfad);
    }
    // Ein Slug, der nur mit „admin" beginnt, ist kein App-Bereich.
    assert.equal(pfadBereinigen('/administration-reinigung')?.pfad, '/administration-reinigung');
  });

  it('verwirft, was kein Pfad dieser Website ist', () => {
    for (const roh of ['', 'kontakt', '//boese.example/x', 'https://boese.example/', '/\\boese', `/${'a'.repeat(400)}`]) {
      assert.equal(pfadBereinigen(roh), null, roh);
    }
  });

  it('kein gespeicherter Pfad enthält je ein Fragezeichen (Datenbankbedingung)', () => {
    for (const roh of ['/a?b=c', '/a%3Fb', '/?utm_source=x', '/offerte/abc?x=1']) {
      const r = pfadBereinigen(roh);
      if (r) {
        assert.ok(!r.pfad.includes('?'), roh);
        assert.ok(r.pfad.startsWith('/'), roh);
        assert.ok(r.pfad.length <= 300, roh);
      }
    }
  });
});

describe('Besuchsmessung — UTM', () => {
  it('trimmt, schreibt klein, kürzt auf 100 Zeichen', () => {
    assert.equal(utmWert('  Newsletter  '), 'newsletter');
    assert.equal(utmWert('x'.repeat(250))?.length, 100);
  });

  it('verwirft E-Mail-Adressen und leere Werte, entfernt Sonderzeichen', () => {
    assert.equal(utmWert('anna@example.ch'), null);
    assert.equal(utmWert('   '), null);
    assert.equal(utmWert(null), null);
    assert.equal(utmWert('<script>alert(1)</script>'), 'scriptalert1script');
  });
});

describe('Besuchsmessung — Referrer', () => {
  const eigene = ['clenaris.ch', 'localhost:3000'];

  it('kürzt auf den Host ohne www.', () => {
    assert.equal(referrerHost('https://www.google.ch/search?q=reinigung+bern', eigene), 'google.ch');
    assert.equal(referrerHost('https://l.facebook.com/l.php?u=https%3A%2F%2Fclenaris.ch', eigene), 'l.facebook.com');
  });

  it('verwirft die eigene Website, fremde Schemata und Unsinn', () => {
    assert.equal(referrerHost('https://clenaris.ch/leistungen', eigene), null);
    assert.equal(referrerHost('https://www.clenaris.ch/', eigene), null);
    assert.equal(referrerHost('http://localhost:3000/kontakt', eigene), null);
    assert.equal(referrerHost('android-app://com.google.android.gm/', eigene), null);
    assert.equal(referrerHost('kein link', eigene), null);
    assert.equal(referrerHost('', eigene), null);
    assert.equal(referrerHost(undefined, eigene), null);
  });
});

describe('Besuchsmessung — Gerät und Browser', () => {
  const faelle: [string, string, string][] = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'DESKTOP', 'CHROME'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0', 'DESKTOP', 'EDGE'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15', 'DESKTOP', 'SAFARI'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0', 'DESKTOP', 'FIREFOX'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'MOBILE', 'SAFARI'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148 Safari/604.1', 'MOBILE', 'CHROME'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36', 'MOBILE', 'CHROME'],
    ['Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'TABLET', 'CHROME'],
    ['Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1', 'TABLET', 'SAFARI'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0', 'DESKTOP', 'OTHER'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36', 'MOBILE', 'OTHER'],
    ['', 'DESKTOP', 'OTHER'],
  ];

  for (const [ua, geraet, browser] of faelle) {
    it(`${geraet}/${browser}: ${ua.slice(0, 60) || '(leer)'}`, () => {
      assert.deepEqual(umgebungAusUserAgent(ua), { geraet, browser });
    });
  }

  it('Automaten zählen nicht', () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36',
      'curl/8.4.0',
      'Mozilla/5.0 (Linux; Android 11; moto g power) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse',
    ]) {
      assert.equal(umgebungAusUserAgent(ua), null, ua);
    }
  });
});

describe('Besuchsmessung — Ablehnungssignale', () => {
  const kopf = (werte: Record<string, string>) => (name: string) => werte[name] ?? null;

  it('Sec-GPC: 1 und DNT: 1 lehnen ab, alles andere nicht', () => {
    assert.equal(verfolgungAbgelehnt(kopf({ 'sec-gpc': '1' })), true);
    assert.equal(verfolgungAbgelehnt(kopf({ dnt: '1' })), true);
    assert.equal(verfolgungAbgelehnt(kopf({ dnt: '0' })), false);
    assert.equal(verfolgungAbgelehnt(kopf({})), false);
  });
});

describe('Besuchsmessung — Sitzungshash', () => {
  const geheimnis = 'ein-geheimnis-das-mindestens-zweiunddreissig-zeichen-hat';

  it('ist innerhalb eines Tages stabil und 64 Hex-Zeichen lang', () => {
    const a = sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', geheimnis);
    assert.equal(a, sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', geheimnis));
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it('wechselt mit dem Tag — zwei Tage lassen sich nicht verknüpfen', () => {
    assert.notEqual(
      sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', geheimnis),
      sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-29', geheimnis),
    );
  });

  it('hängt vom Servergeheimnis ab und enthält die Kennung nicht', () => {
    const a = sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', geheimnis);
    assert.notEqual(a, sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', `${geheimnis}x`));
    assert.ok(!a.includes('Q2x5aUtOa3lPZ3pZ'.toLowerCase()));
    assert.throws(() => sitzungsHash('Q2x5aUtOa3lPZ3pZ', '2026-09-28', ''));
  });
});

describe('Besuchsmessung — Zeiträume in Zürcher Tagen', () => {
  // 28. September 2026, 23:30 Zürcher Zeit = 21:30 UTC — der Zürcher Tag ist der 28.
  const jetzt = new Date('2026-09-28T21:30:00.000Z');

  it('Heute, 7 und 30 Tage schliessen heute ein', () => {
    const h = trafficZeitraumAufloesen('heute', undefined, undefined, jetzt);
    assert.equal(text(h.vonTag), '2026-09-28');
    assert.equal(text(h.bisTag), '2026-09-28');
    assert.equal(h.tage, 1);

    const w = trafficZeitraumAufloesen('7tage', undefined, undefined, jetzt);
    assert.equal(text(w.vonTag), '2026-09-22');
    assert.equal(w.tage, 7);
    assert.equal(text(w.vorher.vonTag), '2026-09-15');
    assert.equal(text(w.vorher.bisTag), '2026-09-21');

    assert.equal(trafficZeitraumAufloesen('30tage', undefined, undefined, jetzt).tage, 30);
  });

  it('kurz nach Mitternacht in Zürich gilt schon der neue Tag', () => {
    // 1. Oktober 00:30 Zürich = 30. September 22:30 UTC
    const r = trafficZeitraumAufloesen('heute', undefined, undefined, new Date('2026-09-30T22:30:00.000Z'));
    assert.equal(text(r.vonTag), '2026-10-01');
    const m = trafficZeitraumAufloesen('monat', undefined, undefined, new Date('2026-09-30T22:30:00.000Z'));
    assert.equal(text(m.vonTag), '2026-10-01');
  });

  it('Monat, Quartal und Jahr beginnen am Kalenderanfang', () => {
    assert.equal(text(trafficZeitraumAufloesen('monat', undefined, undefined, jetzt).vonTag), '2026-09-01');
    assert.equal(text(trafficZeitraumAufloesen('quartal', undefined, undefined, jetzt).vonTag), '2026-07-01');
    assert.equal(text(trafficZeitraumAufloesen('jahr', undefined, undefined, jetzt).vonTag), '2026-01-01');
  });

  it('eigener Zeitraum: getauscht, in der Zukunft gekappt, auf 400 Tage begrenzt', () => {
    const r = trafficZeitraumAufloesen('eigen', '2026-09-10', '2026-09-01', jetzt);
    assert.equal(text(r.vonTag), '2026-09-01');
    assert.equal(text(r.bisTag), '2026-09-10');

    const z = trafficZeitraumAufloesen('eigen', '2026-09-20', '2027-01-01', jetzt);
    assert.equal(text(z.bisTag), '2026-09-28');

    const lang = trafficZeitraumAufloesen('eigen', '2020-01-01', '2026-09-28', jetzt);
    assert.equal(lang.tage, 400);
    assert.equal(text(lang.bisTag), '2026-09-28');
  });

  it('ein unbrauchbarer eigener Zeitraum fällt auf 30 Tage zurück', () => {
    for (const [von, bis] of [[undefined, undefined], ['2026-02-31', '2026-03-05'], ['gestern', '2026-09-01']] as const) {
      const r = trafficZeitraumAufloesen('eigen', von, bis, jetzt);
      assert.equal(r.art, '30tage');
      assert.equal(r.tage, 30);
    }
  });

  it('Aufbewahrung: heute vor 13 Kalendermonaten, Monatsende sauber', () => {
    assert.equal(text(aufbewahrungsgrenze(jetzt)), '2025-08-28');
    // 31. März 2027 → 29. Februar gibt es 2026 nicht → 28. Februar 2026
    assert.equal(text(aufbewahrungsgrenze(new Date('2027-03-31T10:00:00.000Z'))), '2026-02-28');
    assert.equal(text(aufbewahrungsgrenze(tag('2026-01-15'))), '2024-12-15');
  });
});

describe('Besuchsmessung — Wertevorrat passt zum Schema', () => {
  const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  const aufzaehlung = (name: string) => {
    const block = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\}`).exec(schema)?.[1] ?? '';
    return block
      .split('\n')
      .map((z) => z.trim())
      .filter((z) => z && !z.startsWith('//'));
  };

  it('Ereignisse, Geräte und Browser sind dieselben wie in prisma/schema.prisma', () => {
    assert.deepEqual(aufzaehlung('TrafficEventName'), [...TRAFFIC_EREIGNISSE]);
    assert.deepEqual(aufzaehlung('TrafficDevice'), [...TRAFFIC_GERAETE]);
    assert.deepEqual(aufzaehlung('TrafficBrowser'), [...TRAFFIC_BROWSER]);
  });
});
