import 'server-only';

import { can, type ActorRole } from '@/lib/auth/rbac';
import { prisma } from '@/lib/db';

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
 */

export interface Treffer {
  art: string;
  id: string;
  titel: string;
  untertitel: string | null;
  link: string;
}

const JE_BEREICH = 5;

export async function globaleSuche(params: { organizationId: string; role: ActorRole; q: string }): Promise<{ q: string; treffer: Treffer[] }> {
  const q = params.q.trim();
  const enthaelt = { contains: q, mode: 'insensitive' as const };
  const org = params.organizationId;
  const darf = (p: Parameters<typeof can>[1]) => can(params.role, p);
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
