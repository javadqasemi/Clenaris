import 'server-only';

import { Prisma, type Release, type ReleaseRequest, type ReleaseRequestStatus } from '@prisma/client';

import { recordAuditInTx } from '@/lib/audit';
import { prisma } from '@/lib/db';
import { BusinessRuleError, ConflictError, NotFoundError } from '@/lib/errors';
import { aktuelleVersion, vergleicheVersionen } from '@/lib/version';
import type { ReleaseManifest } from '@/lib/validation/system';

/**
 * Versionsverwaltung — das Update Center der Systemverantwortung
 * (Produktsprint 2026-09-26).
 *
 * ---------------------------------------------------------------------------
 *  Was dieser Dienst ist, und was er ausdrücklich nicht ist
 * ---------------------------------------------------------------------------
 *
 * Er ist ein **Entscheidungsregister**: Welche Versionen gibt es, was bringen
 * sie, und was hat der Betrieb beschlossen — freigeben, terminieren, den
 * Termin stornieren, zurückstellen. Jede Entscheidung ist eine Zeile und ein
 * Protokolleintrag im selben Commit.
 *
 * Er ist **kein Ausführer**. Keine Zeile hier ruft eine Shell, `npm`, `git`,
 * SSH, einen Neustart oder `prisma migrate deploy` auf, und die Anwendung
 * erhält dafür weder Deployment-Schlüssel noch GitHub-Geheimnisse noch
 * Root-Zugang. Der Grund ist nicht Vorsicht, sondern die Angriffsfläche: Ein
 * Dashboard, das Code auf den Server holt und ausführt, macht aus jedem
 * übernommenen Systemverantwortungs-Konto — einem Phishing-Opfer, einem
 * gestohlenen Sitzungscookie — eine Fernsteuerung des Servers. Die
 * Anmeldung einer Web-Anwendung ist dafür die falsche Schranke.
 *
 * Die Ausführung gehört einem vertrauenswürdigen Werkzeug ausserhalb der
 * Anwendung (Production V2, `deploy/v2/`), das die fälligen Aufträge dieser
 * Tabelle abholt und das Release-Artefakt anhand seiner Prüfsumme
 * (`artifactSha256`) ausrollt. Seit 2026-09-27 gibt es dafür die signierte
 * Schnittstelle `/api/cron/release-auftraege` (`release-ausfuehrung.service.ts`),
 * das Werkzeug `scripts/release-ausfuehrer.ts` und die Vorlage
 * `deploy/v2/release-ausfuehrer.yml` — angeschlossen wird sie erst mit der
 * Freigabe von Production V2. Die Zustände DEPLOYING, SUCCEEDED, FAILED und
 * ROLLED_BACK setzt nur der Ausführer; keine Handlung hier führt in sie. Der
 * Auftrag trägt auch kein Ziel (Host, Adresse): Wohin ausgerollt wird,
 * entscheidet der Ausführer aus seiner eigenen Konfiguration, nicht ein
 * Datensatz, den ein Browser mitgestalten könnte.
 *
 * ---------------------------------------------------------------------------
 *  Zustandsmaschine (je Organisation und Version)
 * ---------------------------------------------------------------------------
 *
 *     AVAILABLE ──freigeben──▶ APPROVED ──terminieren──▶ SCHEDULED
 *         │                                                 │  ▲
 *         └────────────terminieren (Freigabe inbegriffen)───┘  │ verschieben
 *                                                           │──┘
 *     SCHEDULED ──stornieren──▶ (Auftrag CANCELLED, Version wieder AVAILABLE)
 *     AVAILABLE ──zurückstellen──▶ AVAILABLE, bis zum Datum ausgeblendet
 *
 * AVAILABLE ist kein gespeicherter Zustand, sondern die Abwesenheit eines
 * offenen Auftrags für eine Version, die neuer ist als die laufende. Eine
 * Version, die nicht neuer ist, ist INSTALLED (gleich) oder OLDER und kennt
 * keine Handlung — eine Rückstufung über das Dashboard gibt es nicht.
 *
 * Jeder unzulässige Übergang ist ein `BusinessRuleError` (422): Die Eingabe
 * war wohlgeformt, die Handlung ist im aktuellen Zustand unmöglich.
 * Gleichzeitigkeit sichert der partielle Index `release_requests_offen_einmal`
 * ab; wer ihn trifft, bekommt 409.
 */

export type ReleaseZustand = 'AVAILABLE' | 'APPROVED' | 'SCHEDULED' | 'DEPLOYING' | 'INSTALLED' | 'OLDER';

export const ZUSTANDSNAMEN: Record<ReleaseZustand, string> = {
  AVAILABLE: 'Update verfügbar',
  APPROVED: 'Freigegeben',
  SCHEDULED: 'Terminiert',
  DEPLOYING: 'Wird installiert',
  INSTALLED: 'Installiert',
  OLDER: 'Älter als die laufende Version',
};

/** Auftragszustände in Worten — für die Verlaufsliste der Detailansicht. */
export const AUFTRAGSNAMEN: Record<ReleaseRequestStatus, string> = {
  APPROVED: 'Freigegeben',
  SCHEDULED: 'Terminiert',
  CANCELLED: 'Storniert',
  DEPLOYING: 'In Ausführung',
  SUCCEEDED: 'Installiert',
  FAILED: 'Fehlgeschlagen',
  ROLLED_BACK: 'Zurückgesetzt',
};

/**
 * Offen heisst: Es ist entschieden, aber noch nicht erledigt. Ein Auftrag in
 * Ausführung gehört dazu (2026-09-27) — sonst liesse sich dieselbe Version
 * während der Installation neu freigeben, und der Teilindex
 * `release_requests_offen_einmal` sähe es genauso.
 */
const OFFEN: ReleaseRequestStatus[] = ['APPROVED', 'SCHEDULED', 'DEPLOYING'];

export const ARTNAMEN: Record<Release['kind'], string> = {
  PATCH: 'Patch',
  MINOR: 'Minor',
  MAJOR: 'Major',
  SECURITY: 'Sicherheit',
};

/** Frühester Termin: Die Vorbereitung (Sicherung, Ankündigung) braucht Zeit. */
const MINDESTVORLAUF_MINUTEN = 15;
/** Spätester Termin: Ein Auftrag, der ein Vierteljahr liegt, ist vergessen. */
const HOECHSTVORLAUF_TAGE = 90;

export interface ReleaseUebersicht {
  release: Release;
  zustand: ReleaseZustand;
  offenerAuftrag: ReleaseRequest | null;
  zurueckgestelltBis: Date | null;
}

function zustandVon(release: Release, offen: ReleaseRequest | null, laufend: string): ReleaseZustand {
  const vergleich = vergleicheVersionen(release.version, laufend);
  if (vergleich === 0) return 'INSTALLED';
  if (vergleich < 0) return 'OLDER';
  if (offen?.status === 'DEPLOYING') return 'DEPLOYING';
  if (offen?.status === 'SCHEDULED') return 'SCHEDULED';
  if (offen?.status === 'APPROVED') return 'APPROVED';
  return 'AVAILABLE';
}

/** Alle bekannten Versionen, neueste zuerst, mit ihrem Zustand für diesen Betrieb. */
export async function listReleases(organizationId: string): Promise<{ laufend: string; releases: ReleaseUebersicht[] }> {
  const laufend = aktuelleVersion();
  const jetzt = new Date();
  const [releases, offene, zurueckgestellt] = await Promise.all([
    prisma.release.findMany(),
    prisma.releaseRequest.findMany({
      where: { organizationId, status: { in: OFFEN } },
    }),
    prisma.releaseDeferral.findMany({
      where: { organizationId, deferredUntil: { gt: jetzt } },
      orderBy: { deferredUntil: 'desc' },
    }),
  ]);

  const uebersicht = releases
    .sort((a, b) => vergleicheVersionen(b.version, a.version))
    .map((release) => {
      const offen = offene.find((r) => r.releaseId === release.id) ?? null;
      return {
        release,
        zustand: zustandVon(release, offen, laufend),
        offenerAuftrag: offen,
        zurueckgestelltBis: zurueckgestellt.find((d) => d.releaseId === release.id)?.deferredUntil ?? null,
      };
    });

  return { laufend, releases: uebersicht };
}

/**
 * Die eine Zahl für das Dashboard: die neueste Version, die neuer ist als die
 * laufende — oder `null`, wenn das System aktuell ist.
 */
export async function neuesteVerfuegbare(organizationId: string) {
  const { laufend, releases } = await listReleases(organizationId);
  const neuer = releases.filter((r) => r.zustand !== 'INSTALLED' && r.zustand !== 'OLDER');
  // „Offen" heisst: Es steht noch eine Entscheidung aus. Terminiert ist
  // entschieden, zurückgestellt auch — beides zählt nicht in die Zahl neben
  // dem Menüeintrag, sonst mahnte sie an etwas, das erledigt ist.
  const anzahlOffen = neuer.filter(
    (r) => (r.zustand === 'AVAILABLE' && !r.zurueckgestelltBis) || r.zustand === 'APPROVED',
  ).length;
  return { laufend, neueste: neuer[0] ?? null, anzahlNeuer: neuer.length, anzahlOffen };
}

export async function getReleaseDetail(organizationId: string, releaseId: string) {
  const laufend = aktuelleVersion();
  const release = await prisma.release.findUnique({ where: { id: releaseId } });
  if (!release) throw new NotFoundError('Version');

  const [auftraege, zurueckgestellt] = await Promise.all([
    prisma.releaseRequest.findMany({
      where: { organizationId, releaseId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.releaseDeferral.findFirst({
      where: { organizationId, releaseId, deferredUntil: { gt: new Date() } },
      orderBy: { deferredUntil: 'desc' },
    }),
  ]);
  const offen = auftraege.find((a) => OFFEN.includes(a.status)) ?? null;

  // Namen der Entscheidenden — nur Vor- und Nachname, für die Zeile „von wem".
  const ids = [
    ...new Set(
      auftraege.flatMap((a) => [a.approvedById, a.scheduledById, a.cancelledById]).filter((id): id is string => Boolean(id)),
    ),
  ];
  const personen = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const namen = Object.fromEntries(personen.map((p) => [p.id, `${p.firstName} ${p.lastName}`]));

  return {
    laufend,
    release,
    zustand: zustandVon(release, offen, laufend),
    offenerAuftrag: offen,
    auftraege,
    namen,
    zurueckgestelltBis: zurueckgestellt?.deferredUntil ?? null,
  };
}

interface Handelnde {
  organizationId: string;
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
}

type Tx = Prisma.TransactionClient;

/**
 * Release und offenen Auftrag unter Zeilensperre lesen.
 *
 * `FOR UPDATE` auf dem offenen Auftrag: Zwei gleichzeitige Handlungen auf
 * *denselben* Auftrag (stornieren und verschieben) laufen nacheinander, die
 * zweite sieht den Zustand nach der ersten. Für das erste Freigeben gibt es
 * noch keine Zeile zum Sperren — dort fängt der partielle Index ab.
 */
async function ladeUnterSperre(tx: Tx, organizationId: string, releaseId: string) {
  const release = await tx.release.findUnique({ where: { id: releaseId } });
  if (!release) throw new NotFoundError('Version');
  const gesperrt = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM release_requests
    WHERE "organizationId" = ${organizationId} AND "releaseId" = ${releaseId}
      AND status IN ('APPROVED', 'SCHEDULED', 'DEPLOYING')
    FOR UPDATE`;
  const offen = gesperrt[0] ? await tx.releaseRequest.findUnique({ where: { id: gesperrt[0].id } }) : null;
  const laufend = aktuelleVersion();
  return { release, offen, laufend, zustand: zustandVon(release, offen, laufend) };
}

function pruefeNeuer(zustand: ReleaseZustand, release: Release, laufend: string) {
  // In Ausführung entscheidet der Ausführer, nicht das Dashboard — weder
  // freigeben noch terminieren noch zurückstellen greift in einen laufenden
  // Auftrag ein. Seine Meldung (erfolgreich, fehlgeschlagen) schliesst ihn.
  if (zustand === 'DEPLOYING') {
    throw new BusinessRuleError(`Version ${release.version} wird gerade installiert. Das Ergebnis meldet der Ausführer.`);
  }
  if (zustand === 'INSTALLED') {
    throw new BusinessRuleError(`Version ${release.version} ist bereits installiert.`);
  }
  if (zustand === 'OLDER') {
    throw new BusinessRuleError(
      `Version ${release.version} ist älter als die laufende Version ${laufend}. Eine Rückstufung über das Dashboard gibt es nicht.`,
    );
  }
}

function pruefeTermin(wann: Date) {
  const frueh = Date.now() + MINDESTVORLAUF_MINUTEN * 60_000;
  const spaet = Date.now() + HOECHSTVORLAUF_TAGE * 86_400_000;
  if (wann.getTime() < frueh) {
    throw new BusinessRuleError(`Der Termin muss mindestens ${MINDESTVORLAUF_MINUTEN} Minuten in der Zukunft liegen.`);
  }
  if (wann.getTime() > spaet) {
    throw new BusinessRuleError(`Der Termin darf höchstens ${HOECHSTVORLAUF_TAGE} Tage in der Zukunft liegen.`);
  }
}

async function protokolliere(
  tx: Tx,
  h: Handelnde,
  action: 'CREATE' | 'UPDATE',
  auftrag: ReleaseRequest,
  summary: string,
  changes: Record<string, unknown>,
) {
  // Im selben Commit wie die Entscheidung: eine Freigabe ohne Protokoll gibt
  // es nicht. Gespeichert werden Versionen, Zeitpunkte und der Grund — keine
  // Artefaktadressen, keine Zugangsdaten; der Auftrag trägt keine. Über
  // `recordAuditInTx`, damit auch hier die Schwärzung greift — der Grund ist
  // Freitext (bis 2026-09-27 ging er direkt in die Tabelle).
  await recordAuditInTx(tx, {
    organizationId: h.organizationId,
    userId: h.actorId,
    action,
    entity: 'ReleaseRequest',
    entityId: auftrag.id,
    summary,
    changes: {
      vonVersion: auftrag.fromVersion,
      zielVersion: auftrag.toVersion,
      ...changes,
    },
    ip: h.ip ?? null,
    userAgent: h.userAgent ?? null,
  });
}

/** Unique-Verletzung des partiellen Index in eine verständliche 409 übersetzen. */
async function mitKonfliktschutz<T>(lauf: () => Promise<T>): Promise<T> {
  try {
    return await lauf();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictError('Für diese Version wurde soeben bereits entschieden. Bitte die Seite neu laden.');
    }
    throw error;
  }
}

/** AVAILABLE → APPROVED. */
export async function releaseFreigeben(h: Handelnde, releaseId: string) {
  return mitKonfliktschutz(() =>
    prisma.$transaction(async (tx) => {
      const { release, offen, laufend, zustand } = await ladeUnterSperre(tx, h.organizationId, releaseId);
      pruefeNeuer(zustand, release, laufend);
      if (offen) {
        throw new BusinessRuleError(
          offen.status === 'SCHEDULED'
            ? `Version ${release.version} ist bereits freigegeben und terminiert.`
            : `Version ${release.version} ist bereits freigegeben.`,
        );
      }
      const jetzt = new Date();
      const auftrag = await tx.releaseRequest.create({
        data: {
          organizationId: h.organizationId,
          releaseId,
          status: 'APPROVED',
          fromVersion: laufend,
          toVersion: release.version,
          approvedById: h.actorId,
          approvedAt: jetzt,
        },
      });
      await protokolliere(tx, h, 'CREATE', auftrag, `Version ${release.version} freigegeben (laufend ${laufend})`, {
        status: { from: 'AVAILABLE', to: 'APPROVED' },
      });
      return auftrag;
    }),
  );
}

/**
 * AVAILABLE/APPROVED → SCHEDULED, oder einen bestehenden Termin verschieben.
 *
 * Terminieren aus AVAILABLE schliesst die Freigabe ein: Wer einen Termin
 * setzt, hat entschieden, dass die Version kommt. Zwei Klicks zu verlangen,
 * wo einer dasselbe sagt, erzeugt nur Aufträge, die zwischen den Klicks
 * liegen bleiben.
 */
export async function releaseTerminieren(h: Handelnde, releaseId: string, scheduledFor: Date) {
  pruefeTermin(scheduledFor);
  return mitKonfliktschutz(() =>
    prisma.$transaction(async (tx) => {
      const { release, offen, laufend, zustand } = await ladeUnterSperre(tx, h.organizationId, releaseId);
      pruefeNeuer(zustand, release, laufend);
      const jetzt = new Date();

      if (!offen) {
        const auftrag = await tx.releaseRequest.create({
          data: {
            organizationId: h.organizationId,
            releaseId,
            status: 'SCHEDULED',
            fromVersion: laufend,
            toVersion: release.version,
            scheduledFor,
            approvedById: h.actorId,
            approvedAt: jetzt,
            scheduledById: h.actorId,
            scheduledAt: jetzt,
          },
        });
        await protokolliere(tx, h, 'CREATE', auftrag, `Version ${release.version} freigegeben und terminiert auf ${scheduledFor.toISOString()}`, {
          status: { from: 'AVAILABLE', to: 'SCHEDULED' },
          termin: { from: null, to: scheduledFor.toISOString() },
        });
        return auftrag;
      }

      const vorher = offen.scheduledFor;
      const auftrag = await tx.releaseRequest.update({
        where: { id: offen.id },
        data: { status: 'SCHEDULED', scheduledFor, scheduledById: h.actorId, scheduledAt: jetzt },
      });
      await protokolliere(
        tx,
        h,
        'UPDATE',
        auftrag,
        offen.status === 'SCHEDULED'
          ? `Termin für Version ${release.version} verschoben auf ${scheduledFor.toISOString()}`
          : `Version ${release.version} terminiert auf ${scheduledFor.toISOString()}`,
        {
          status: { from: offen.status, to: 'SCHEDULED' },
          termin: { from: vorher?.toISOString() ?? null, to: scheduledFor.toISOString() },
        },
      );
      return auftrag;
    }),
  );
}

/**
 * SCHEDULED → CANCELLED. Der Auftrag bleibt als Nachweis stehen; die Version
 * ist danach wieder verfügbar und kann erneut freigegeben werden.
 *
 * Nur aus SCHEDULED: Das ist die Handlung, die das Dashboard anbietet
 * („Termin stornieren"). Eine blosse Freigabe ohne Termin löst noch nichts
 * aus; sie zurückzunehmen wäre ein eigener Vorgang, den heute niemand
 * braucht.
 */
export async function releaseTerminStornieren(h: Handelnde, releaseId: string, grund?: string) {
  return prisma.$transaction(async (tx) => {
    const { release, offen, zustand } = await ladeUnterSperre(tx, h.organizationId, releaseId);
    if (!offen || offen.status !== 'SCHEDULED') {
      throw new BusinessRuleError(
        `Für Version ${release.version} gibt es keinen Termin, der storniert werden könnte (Zustand: ${ZUSTANDSNAMEN[zustand]}).`,
      );
    }
    const jetzt = new Date();
    const auftrag = await tx.releaseRequest.update({
      where: { id: offen.id },
      data: { status: 'CANCELLED' satisfies ReleaseRequestStatus, cancelledById: h.actorId, cancelledAt: jetzt, cancelReason: grund ?? null },
    });
    await protokolliere(tx, h, 'UPDATE', auftrag, `Termin für Version ${release.version} storniert${grund ? `: ${grund}` : ''}`, {
      status: { from: 'SCHEDULED', to: 'CANCELLED' },
      termin: { from: offen.scheduledFor?.toISOString() ?? null, to: null },
      grund: grund ?? null,
    });
    return auftrag;
  });
}

/** „Nicht jetzt": eine verfügbare Version für einige Tage ausblenden. */
export async function releaseZurueckstellen(h: Handelnde, releaseId: string, tage: number) {
  return prisma.$transaction(async (tx) => {
    const { release, offen, laufend, zustand } = await ladeUnterSperre(tx, h.organizationId, releaseId);
    pruefeNeuer(zustand, release, laufend);
    if (offen) {
      throw new BusinessRuleError(
        `Version ${release.version} ist bereits freigegeben — zurückstellen lässt sich nur, worüber noch nicht entschieden ist.`,
      );
    }
    const bis = new Date(Date.now() + tage * 86_400_000);
    const eintrag = await tx.releaseDeferral.create({
      data: { organizationId: h.organizationId, releaseId, deferredById: h.actorId, deferredUntil: bis },
    });
    await recordAuditInTx(tx, {
      organizationId: h.organizationId,
      userId: h.actorId,
      action: 'UPDATE',
      entity: 'ReleaseDeferral',
      entityId: eintrag.id,
      summary: `Version ${release.version} zurückgestellt bis ${bis.toISOString()}`,
      changes: { vonVersion: laufend, zielVersion: release.version, zurueckgestelltBis: bis.toISOString() },
      ip: h.ip ?? null,
      userAgent: h.userAgent ?? null,
    });
    return eintrag;
  });
}

/**
 * Eine Version eintragen — nur für `scripts/release-registrieren.ts`, nie über
 * einen Endpunkt (Begründung am Schema).
 *
 * Unveränderlich: Existiert die Nummer schon mit anderem Inhalt, wird
 * abgelehnt. Sonst könnte eine bereits freigegebene Version nachträglich ein
 * anderes Änderungsprotokoll bekommen — die Freigabe bezöge sich dann auf
 * etwas, das niemand gesehen hat.
 */
export async function releaseEintragen(manifest: ReleaseManifest): Promise<{ angelegt: boolean; release: Release }> {
  const daten = {
    version: manifest.version,
    releasedAt: new Date(manifest.releasedAt),
    kind: manifest.kind,
    securitySeverity: manifest.securitySeverity,
    summary: manifest.summary,
    features: manifest.features,
    fixes: manifest.fixes,
    securityFixes: manifest.securityFixes,
    uiChanges: manifest.uiChanges,
    migrations: manifest.migrations,
    breakingChanges: manifest.breakingChanges,
    manualActions: manifest.manualActions,
    expectedDowntimeMinutes: manifest.expectedDowntimeMinutes,
    rollbackAvailable: manifest.rollbackAvailable,
    ciStatus: manifest.ciStatus,
    compatibility: manifest.compatibility,
    commit: manifest.commit,
    artifactSha256: manifest.artifactSha256,
    artifactSizeBytes: manifest.artifactSizeBytes,
  };
  const bestehend = await prisma.release.findUnique({ where: { version: manifest.version } });
  if (bestehend) {
    const gleich = (Object.keys(daten) as (keyof typeof daten)[]).every(
      (k) => JSON.stringify(bestehend[k]) === JSON.stringify(daten[k]),
    );
    if (!gleich) {
      throw new BusinessRuleError(
        `Version ${manifest.version} ist bereits mit anderem Inhalt eingetragen. Eine Version wird nicht umgeschrieben — neue Nummer vergeben.`,
      );
    }
    return { angelegt: false, release: bestehend };
  }
  return { angelegt: true, release: await prisma.release.create({ data: daten }) };
}
