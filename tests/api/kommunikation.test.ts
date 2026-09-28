import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  naechsterStatus,
  pruefeSvixSignatur,
  pruefeTwilioSignatur,
  resendEreignis,
  svixSignatur,
  twilioStatus,
} from '../../src/lib/kommunikation/zustellung';
import { BASE_URL, data, get, requireServer } from '../helpers/client';
import { loginAll, type AccountName } from '../helpers/accounts';
import { eigeneOrganisationId, fremdeOrganisation, testDb, testDbGrund, testDbSchliessen } from '../helpers/testdb';
import { PRUEF_RESEND_GEHEIMNIS } from '../helpers/webhooks';

/**
 * Wave 14 — Kommunikation: Zustellstatus, Webhooks, Protokoll, Bewertungsbitte.
 *
 * Die Regeln (Rangfolge, Signaturen) direkt; der Weg über HTTP mit einer
 * echten Svix-Signatur (Geheimnis vom Testserver, `tests/helpers/webhooks.ts`).
 * Die Protokollzeilen, auf die die Meldungen zielen, legt die Prüfung selbst
 * an — ohne Anbieter entstehen nur „simulierte" Zeilen ohne Anbieterkennung.
 */

describe('Rangfolge des Zustellstatus', () => {
  it('bewegt sich nur vorwärts — eine späte „gesendet"-Meldung überschreibt „zugestellt" nicht', () => {
    assert.equal(naechsterStatus('sent', 'delivered'), 'delivered');
    assert.equal(naechsterStatus('delivered', 'sent'), null);
    assert.equal(naechsterStatus('delivered', 'delivered'), null, 'doppelte Meldung');
    assert.equal(naechsterStatus('simulated', 'sent'), 'sent');
  });

  it('ein Abprall nach der Zustellung überschreibt sie; danach nichts Besseres mehr', () => {
    assert.equal(naechsterStatus('delivered', 'bounced'), 'bounced');
    assert.equal(naechsterStatus('bounced', 'delivered'), null);
    assert.equal(naechsterStatus('bounced', 'complained'), 'complained');
  });

  it('Anbieterereignisse werden abgebildet, Unbekanntes ignoriert', () => {
    assert.deepEqual(resendEreignis('email.delivered'), { status: 'delivered' });
    assert.deepEqual(resendEreignis('email.opened'), { geoeffnet: true });
    assert.deepEqual(resendEreignis('email.irgendwas'), {});
    assert.equal(twilioStatus('undelivered'), 'undelivered');
    assert.equal(twilioStatus('sending'), undefined);
  });
});

describe('Signaturen', () => {
  const geheimnis = PRUEF_RESEND_GEHEIMNIS;
  it('Svix: gültig, falsches Geheimnis, veralteter Zeitstempel, manipulierter Text', () => {
    const jetzt = Date.now();
    const ts = String(Math.floor(jetzt / 1000));
    const text = '{"type":"email.delivered"}';
    const sig = svixSignatur(geheimnis, 'msg_1', ts, text);
    assert.ok(pruefeSvixSignatur({ geheimnis, id: 'msg_1', zeitstempel: ts, signaturen: sig, rohtext: text, jetzt }));
    assert.ok(!pruefeSvixSignatur({ geheimnis: `whsec_${Buffer.from('anders').toString('base64')}`, id: 'msg_1', zeitstempel: ts, signaturen: sig, rohtext: text, jetzt }));
    assert.ok(!pruefeSvixSignatur({ geheimnis, id: 'msg_1', zeitstempel: ts, signaturen: sig, rohtext: text, jetzt: jetzt + 10 * 60_000 }), 'Wiedereinspielen');
    assert.ok(!pruefeSvixSignatur({ geheimnis, id: 'msg_1', zeitstempel: ts, signaturen: sig, rohtext: `${text} `, jetzt }));
    assert.ok(pruefeSvixSignatur({ geheimnis, id: 'msg_1', zeitstempel: ts, signaturen: `v1,falsch ${sig}`, rohtext: text, jetzt }), 'mehrere Signaturen (Schlüsselwechsel)');
  });

  it('Twilio: URL plus sortierte Felder, HMAC-SHA1', () => {
    const felder = { MessageSid: 'SM1', MessageStatus: 'delivered' };
    const url = 'https://clenaris.ch/api/webhooks/twilio';
    const sig = createHmac('sha1', 'token').update(`${url}MessageSidSM1MessageStatusdelivered`).digest('base64');
    assert.ok(pruefeTwilioSignatur({ authToken: 'token', url, felder, signatur: sig }));
    assert.ok(!pruefeTwilioSignatur({ authToken: 'token', url: 'http://intern:3000/api/webhooks/twilio', felder, signatur: sig }), 'die interne Adresse taugt nicht');
  });
});

describe('Zustellmeldungen über HTTP', () => {
  let jars: Record<AccountName, string>;
  const RUN = Date.now();
  const providerId = `pruef-${RUN}`;
  let zeileId = '';
  let fremdeZeileId = '';

  const melde = async (typ: string, geheimnis = PRUEF_RESEND_GEHEIMNIS, alterSek = 0, id = providerId) => {
    const text = JSON.stringify({ type: typ, created_at: new Date().toISOString(), data: { email_id: id } });
    const ts = String(Math.floor(Date.now() / 1000) - alterSek);
    const svixId = `msg_${Math.random().toString(36).slice(2)}`;
    return fetch(`${BASE_URL}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': svixSignatur(geheimnis, svixId, ts, text) },
      body: text,
    });
  };

  before(async () => {
    await requireServer();
    jars = await loginAll();
    const db = testDb();
    assert.ok(db, `kein Zugang zur Testdatenbank: ${testDbGrund()}`);
    await db.emailLog.deleteMany({ where: { providerId: { startsWith: 'pruef-' } } });
    const zeile = await db.emailLog.create({
      data: { organizationId: (await eigeneOrganisationId())!, to: 'pruef.zustellung@example.ch', from: 'noreply@clenaris.ch', subject: 'Prüfreihe Zustellung', providerId, status: 'sent', templateKey: 'pruefreihe' },
    });
    zeileId = zeile.id;
    // Dieselbe Suche, eine fremde Organisation: darf im Protokoll nicht stehen.
    fremdeZeileId = (
      await db.emailLog.create({
        data: { organizationId: (await fremdeOrganisation())!, to: 'pruef.zustellung@example.ch', from: 'noreply@fremd.example.ch', subject: 'Prüfreihe Zustellung fremd', providerId: `${providerId}-fremd`, status: 'sent' },
      })
    ).id;
  });

  after(async () => {
    await testDb()?.emailLog.deleteMany({ where: { providerId: { startsWith: 'pruef-' } } });
    await testDbSchliessen();
  });

  it('eine falsche oder veraltete Signatur wird abgewiesen', async () => {
    assert.equal((await melde('email.delivered', `whsec_${Buffer.from('falsch').toString('base64')}`)).status, 401);
    assert.equal((await melde('email.delivered', PRUEF_RESEND_GEHEIMNIS, 600)).status, 401);
    const zeile = await testDb()!.emailLog.findUnique({ where: { id: zeileId } });
    assert.equal(zeile?.status, 'sent', 'nichts geändert');
  });

  it('zugestellt, danach eine späte „gesendet"-Meldung: bleibt zugestellt', async () => {
    assert.equal((await melde('email.delivered')).status, 200);
    assert.equal((await melde('email.sent')).status, 200);
    const zeile = await testDb()!.emailLog.findUnique({ where: { id: zeileId } });
    assert.equal(zeile?.status, 'delivered');
    assert.ok(zeile?.deliveredAt);
  });

  it('Öffnen hält den ersten Zeitpunkt fest; ein Abprall überschreibt die Zustellung', async () => {
    await melde('email.opened');
    const erstes = (await testDb()!.emailLog.findUnique({ where: { id: zeileId } }))?.openedAt;
    await melde('email.opened');
    assert.equal((await testDb()!.emailLog.findUnique({ where: { id: zeileId } }))?.openedAt?.getTime(), erstes?.getTime());
    await melde('email.bounced');
    assert.equal((await testDb()!.emailLog.findUnique({ where: { id: zeileId } }))?.status, 'bounced');
  });

  it('eine unbekannte Kennung ist kein Fehler (andere Umgebung)', async () => {
    const r = await melde('email.delivered', PRUEF_RESEND_GEHEIMNIS, 0, 'pruef-unbekannt');
    assert.equal(r.status, 200);
    assert.equal((await r.json()).gefunden, false);
  });

  it('Twilio ohne Token oder ohne Signatur: abgewiesen', async () => {
    const r = await fetch(`${BASE_URL}/api/webhooks/twilio`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'MessageSid=SM1&MessageStatus=delivered',
    });
    assert.ok([401, 503].includes(r.status), `kam ${r.status}`);
  });

  it('das Zustellprotokoll zeigt den Status laut Anbieter — nur für die Verwaltung', async () => {
    const liste = await get<{ data: { eintraege: { id: string; status: string }[] } }>('/api/communication/logs?kanal=email&suche=pruef.zustellung', { jar: jars.admin });
    assert.equal(liste.status, 200);
    assert.equal(data(liste).eintraege.find((e) => e.id === zeileId)?.status, 'bounced');
    assert.ok(!data(liste).eintraege.some((e) => e.id === fremdeZeileId), 'die Zeile einer fremden Organisation steht im Protokoll');
    for (const rolle of ['employee', 'customer'] as AccountName[]) {
      assert.equal((await get('/api/communication/logs', { jar: jars[rolle] })).status, 403, rolle);
    }
  });
});

describe('Bewertungsbitte: einmal je Buchung', () => {
  let buchungId = '';
  let vorher: Date | null = null;

  before(async () => {
    await requireServer();
    const db = testDb();
    if (!db) return;
    const kandidat = await db.booking.findFirst({
      where: { status: 'COMPLETED', deletedAt: null, reviews: { none: {} } },
      select: { id: true, completedAt: true },
    });
    if (!kandidat) return;
    buchungId = kandidat.id;
    vorher = kandidat.completedAt;
    // Alter (bis 2026-09-28, führte auf eine 404) und neuer Verweis.
    await db.notification.deleteMany({ where: { link: { in: [`/konto/bewertungen/neu?buchung=${buchungId}`, `/konto/bewertungen?buchung=${buchungId}`] } } });
    await db.emailLog.deleteMany({ where: { entity: 'Booking', entityId: buchungId, templateKey: 'review_request' } });
    // Ins Fenster der Bewertungsbitte (24–72 h nach Abschluss) legen.
    await db.booking.update({ where: { id: buchungId }, data: { completedAt: new Date(Date.now() - 30 * 3_600_000) } });
  });

  after(async () => {
    const db = testDb();
    if (db && buchungId) await db.booking.update({ where: { id: buchungId }, data: { completedAt: vorher } });
    await testDbSchliessen();
  });

  it('zwei Tagesläufe ergeben genau eine Bitte (vorher griff die Sperre nie)', async (t) => {
    if (!buchungId) return t.skip('keine abgeschlossene Buchung ohne Bewertung im Bestand');
    const secret = process.env.CRON_SECRET ?? 'dev-cron-secret';
    for (let i = 0; i < 2; i++) {
      const lauf = await get('/api/cron/daily', { headers: { authorization: `Bearer ${secret}` } });
      assert.equal(lauf.status, 200, lauf.text.slice(0, 300));
    }
    const bitten = await testDb()!.notification.count({ where: { link: `/konto/bewertungen?buchung=${buchungId}` } });
    assert.ok(bitten <= 1, `höchstens eine Bitte, gezählt ${bitten}`);
    // Audit 2026-09-28 (L-04): Der alte Verweis auf `/konto/bewertungen/neu` war eine 404.
    const alte = await testDb()!.notification.count({ where: { link: `/konto/bewertungen/neu?buchung=${buchungId}` } });
    assert.equal(alte, 0, 'Bewertungsbitte zeigt noch auf die nicht vorhandene Seite /konto/bewertungen/neu');
    const mails = await testDb()!.emailLog.findMany({ where: { entity: 'Booking', entityId: buchungId, templateKey: 'review_request' } });
    assert.ok(mails.length <= 1, `höchstens eine Mail, gezählt ${mails.length}`);
    assert.ok(bitten + mails.length >= 1, 'die Bitte ging hinaus (Konto oder E-Mail)');
  });
});
