import 'server-only';

import { can } from '@/lib/auth/rbac';
import type { SessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db';
import { documentVisibilityWhere } from '@/server/services/document.service';
import { propertyVisibilityWhere } from '@/server/services/property.service';

/**
 * Globale Suche (Wave 17, 2026-09-23).
 *
 * ---------------------------------------------------------------------------
 *  Die Regeln
 * ---------------------------------------------------------------------------
 *
 *  • **Jeder Bereich nur mit seiner Leseberechtigung.** Die Suche ist kein
 *    zweiter Weg zu Daten: Wer Rechnungen nicht lesen darf, findet auch keine
 *    Rechnungsnummer. Die Prüfung ist dieselbe `can()` wie auf den Seiten.
 *  • **Organisation in jeder Abfrage** — `organizationId` im `where`, wie
 *    überall. Eine Suche, die quer über Mandanten träfe, wäre das Leck mit der
 *    grössten Reichweite.
 *  • **Keine sensiblen Felder als Treffergrund.** Gesucht wird in Namen,
 *    Nummern, Titeln, E-Mail-Adressen der Kundschaft — nie in Lohn, IBAN,
 *    AHV-Nummer, Notizen oder Nachrichtentexten. Eine Suche nach einer
 *    AHV-Nummer, die eine Person findet, verriete die Nummer.
 *  • **Höchstens fünf Treffer je Bereich**, neueste zuerst — eine Suche ist
 *    ein Sprung, keine Liste; die Liste hat der Bereich selbst.
 *  • **Datensatzbezogene Rechte brauchen ihre Sichtbarkeitsbedingung.**
 *    `property:read` besitzen Büro, Mitarbeitende *und* Kundschaft; welche
 *    Objekte jemand sieht, entscheidet `propertyVisibilityWhere`, nicht die
 *    Berechtigung. Dasselbe gilt für Dokumente (`documentVisibilityWhere`).
 *    Deshalb bekommt die Suche die ganze Sitzung und nicht nur die Rolle:
 *    Mit der Rolle allein hätte eine Mitarbeiterin über die Suche jedes Objekt
 *    samt Adresse gefunden, das ihr die Objektliste zu Recht verschweigt.
 *
 *  Seit dem Produktsprint vom 2026-09-26 kommen Objekte, Buchungen und
 *  Dokumente dazu — die drei Bereiche, nach denen im Büro am häufigsten
 *  gefragt wird („die Buchung von Müller", „das Objekt an der
 *  Bahnhofstrasse"). Die Reihenfolge der Aufgaben unten ist die Reihenfolge
 *  der Gruppen in der Kopfzeilensuche: erst die Person, dann ihr Objekt, dann
 *  die Vorgänge in der Reihenfolge, in der sie entstehen.
 */

export interface Treffer {
  art: string;
  id: string;
  titel: string;
  untertitel: string | null;
  link: string;
}

const JE_BEREICH = 5;

export async function globaleSuche(params: { organizationId: string; session: SessionUser; q: string }): Promise<{ q: string; treffer: Treffer[] }> {
  const q = params.q.trim();
  const enthaelt = { contains: q, mode: 'insensitive' as const };
  const org = params.organizationId;
  const darf = (p: Parameters<typeof can>[1]) => can(params.session.role, p);
  const aufgaben: Promise<Treffer[]>[] = [];

  if (darf('customer:read')) {
    aufgaben.push(
      prisma.customer
        .findMany({
          where: {
            organizationId: org,
            deletedAt: null,
            OR: [{ firstName: enthaelt }, { lastName: enthaelt }, { companyName: enthaelt }, { email: enthaelt }, { number: enthaelt }],
          },
          select: { id: true, number: true, firstName: true, lastName: true, companyName: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) =>
          r.map((k) => ({
            art: 'Kundschaft',
            id: k.id,
            titel: k.companyName ?? `${k.firstName} ${k.lastName}`,
            untertitel: k.number,
            link: `/admin/kunden/${k.id}`,
          })),
        ),
    );
  }
  if (darf('property:read')) {
    // Die Sichtbarkeit kommt aus derselben Funktion wie die Objektliste —
    // Mitarbeitende finden nur Objekte mit eigenem Einsatz (siehe oben).
    aufgaben.push(
      prisma.property
        .findMany({
          where: {
            AND: [
              propertyVisibilityWhere(params.session, org),
              {
                OR: [
                  { label: enthaelt },
                  { address: { street: enthaelt } },
                  { address: { city: enthaelt } },
                  { address: { postalCode: enthaelt } },
                  { customer: { companyName: enthaelt } },
                  { customer: { lastName: enthaelt } },
                ],
              },
            ],
          },
          select: {
            id: true,
            label: true,
            customerId: true,
            address: { select: { street: true, streetNo: true, postalCode: true, city: true } },
            customer: { select: { companyName: true, firstName: true, lastName: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) =>
          r.map((o) => {
            const kunde = o.customer.companyName ?? `${o.customer.firstName} ${o.customer.lastName}`;
            const adresse = o.address
              ? [`${o.address.street} ${o.address.streetNo ?? ''}`.trim(), `${o.address.postalCode} ${o.address.city}`].join(', ')
              : null;
            return {
              art: 'Objekt',
              id: o.id,
              titel: `${kunde} — ${o.label}`,
              untertitel: adresse,
              // Objekte haben keine eigene Detailseite; sie stehen in der
              // Kundenakte, und dorthin führt der Treffer.
              link: `/admin/kunden/${o.customerId}`,
            };
          }),
        ),
    );
  }
  if (darf('booking:read')) {
    aufgaben.push(
      prisma.booking
        .findMany({
          where: {
            organizationId: org,
            deletedAt: null,
            OR: [
              { number: enthaelt },
              { customer: { companyName: enthaelt } },
              { customer: { lastName: enthaelt } },
              { customer: { firstName: enthaelt } },
              { items: { some: { name: enthaelt } } },
            ],
          },
          select: {
            id: true,
            number: true,
            scheduledStart: true,
            customer: { select: { companyName: true, firstName: true, lastName: true } },
          },
          orderBy: { scheduledStart: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) =>
          r.map((b) => ({
            art: 'Buchung',
            id: b.id,
            titel: `${b.number} — ${b.customer.companyName ?? `${b.customer.firstName} ${b.customer.lastName}`}`,
            untertitel: new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' }).format(b.scheduledStart),
            link: `/admin/buchungen/${b.id}`,
          })),
        ),
    );
  }
  if (darf('lead:read')) {
    aufgaben.push(
      prisma.lead
        .findMany({
          where: { organizationId: org, deletedAt: null, OR: [{ firstName: enthaelt }, { lastName: enthaelt }, { company: enthaelt }, { email: enthaelt }, { number: enthaelt }] },
          select: { id: true, number: true, firstName: true, lastName: true, company: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((l) => ({ art: 'Anfrage', id: l.id, titel: l.company ?? `${l.firstName} ${l.lastName}`, untertitel: l.number, link: `/admin/leads/${l.id}` }))),
    );
  }
  if (darf('quote:read')) {
    aufgaben.push(
      prisma.quote
        .findMany({
          where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
          select: { id: true, number: true, title: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((o) => ({ art: 'Offerte', id: o.id, titel: o.number, untertitel: o.title, link: `/admin/offerten/${o.id}` }))),
      prisma.siteVisit
        .findMany({
          where: { organizationId: org, number: enthaelt },
          select: { id: true, number: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((b) => ({ art: 'Besichtigung', id: b.id, titel: b.number, untertitel: null, link: `/admin/besichtigungen/${b.id}` }))),
    );
  }
  if (darf('invoice:read')) {
    aufgaben.push(
      prisma.invoice
        .findMany({
          where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { billToName: enthaelt }, { billToCompany: enthaelt }] },
          select: { id: true, number: true, billToName: true, billToCompany: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((i) => ({ art: 'Rechnung', id: i.id, titel: i.number, untertitel: i.billToCompany ?? i.billToName, link: `/admin/rechnungen/${i.id}` }))),
    );
  }
  // Dokumente nur mit dem vollen Leserecht: `document:read_own` (Mitarbeitende)
  // hat keinen Weg in die Dokumentenablage der Administration, ein Treffer
  // dorthin wäre ein toter Link. Welche Dokumente die Rolle sieht, entscheidet
  // `documentVisibilityWhere` — die Betriebsleitung findet keine Personalakten
  // anderer Leute.
  if (darf('document:read')) {
    aufgaben.push(
      prisma.managedDocument
        .findMany({
          where: {
            AND: [
              documentVisibilityWhere(params.session, org),
              { OR: [{ title: enthaelt }, { tags: { has: q } }] },
            ],
          },
          select: { id: true, title: true, category: true },
          orderBy: { updatedAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((d) => ({ art: 'Dokument', id: d.id, titel: d.title, untertitel: null, link: `/admin/fuehrung/dokumente/${d.id}` }))),
    );
  }
  if (darf('job:read')) {
    aufgaben.push(
      prisma.job
        .findMany({
          where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
          select: { id: true, number: true, title: true },
          orderBy: { scheduledStart: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((j) => ({ art: 'Einsatz', id: j.id, titel: j.number, untertitel: j.title, link: `/admin/einsaetze/${j.id}` }))),
    );
  }
  if (darf('contract:read')) {
    aufgaben.push(
      prisma.contract
        .findMany({
          where: { organizationId: org, deletedAt: null, OR: [{ number: enthaelt }, { title: enthaelt }] },
          select: { id: true, number: true, title: true },
          orderBy: { createdAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((c) => ({ art: 'Vertrag', id: c.id, titel: c.number ?? c.title, untertitel: c.title, link: `/admin/vertraege/${c.id}` }))),
    );
  }
  if (darf('employee:read')) {
    aufgaben.push(
      prisma.employee
        .findMany({
          where: { organizationId: org, OR: [{ employeeNumber: enthaelt }, { user: { firstName: enthaelt } }, { user: { lastName: enthaelt } }] },
          select: { id: true, employeeNumber: true, position: true, user: { select: { firstName: true, lastName: true } } },
          orderBy: { employeeNumber: 'asc' },
          take: JE_BEREICH,
        })
        .then((r) =>
          r.map((e) => ({ art: 'Personal', id: e.id, titel: `${e.user.firstName} ${e.user.lastName}`, untertitel: `${e.employeeNumber} · ${e.position}`, link: `/admin/personal/${e.id}` })),
        ),
    );
  }
  if (darf('complaint:read')) {
    aufgaben.push(
      prisma.complaint
        .findMany({
          where: { organizationId: org, OR: [{ number: enthaelt }, { title: enthaelt }] },
          select: { id: true, number: true, title: true },
          orderBy: { reportedAt: 'desc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((c) => ({ art: 'Reklamation', id: c.id, titel: c.number, untertitel: c.title, link: `/admin/reklamationen/${c.id}` }))),
    );
  }
  if (darf('inventory:read')) {
    aufgaben.push(
      prisma.material
        .findMany({
          where: { organizationId: org, OR: [{ sku: enthaelt }, { name: enthaelt }] },
          select: { id: true, sku: true, name: true },
          orderBy: { name: 'asc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((m) => ({ art: 'Material', id: m.id, titel: m.name, untertitel: m.sku, link: `/admin/material` }))),
    );
  }
  if (darf('equipment:read')) {
    aufgaben.push(
      prisma.equipment
        .findMany({
          where: { organizationId: org, OR: [{ inventoryNumber: enthaelt }, { name: enthaelt }, { serialNumber: enthaelt }] },
          select: { id: true, inventoryNumber: true, name: true },
          orderBy: { inventoryNumber: 'asc' },
          take: JE_BEREICH,
        })
        .then((r) => r.map((g) => ({ art: 'Gerät', id: g.id, titel: g.name, untertitel: g.inventoryNumber, link: `/admin/geraete` }))),
    );
  }

  const ergebnisse = await Promise.all(aufgaben);
  return { q, treffer: ergebnisse.flat() };
}
