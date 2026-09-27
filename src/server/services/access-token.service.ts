import 'server-only';

import type { PublicAccessToken, PublicTokenPurpose } from '@prisma/client';

import { prisma, type Tx } from '@/lib/db';
import { audit } from '@/lib/audit';
import { recordSecurityEvent } from '@/lib/security/record';
import { NotFoundError } from '@/lib/errors';
import { randomToken } from '@/lib/auth/jwt';
import { legacyTokensAllowed, purposesSatisfying } from '@/lib/auth/public-token-policy';
import { sha256Hex } from '@/lib/crypto';
import { zuercherTagText } from '@/lib/zuerich';
import { getOrganizationId } from './organization.service';

/**
 * Öffentliche Zugriffstokens — die eine Stelle für Links ohne Anmeldung.
 *
 * ---------------------------------------------------------------------------
 *  Warum es das gibt
 * ---------------------------------------------------------------------------
 *
 * `Quote.publicToken` und `Invoice.publicToken` waren `@default(cuid())`, und
 * die Route dazu behauptete, der Token sei „unerratbar (cuid)". Das ist
 * falsch: cuid v1 ist eine kollisionsarme Kennung, kein Geheimnis. Es setzt
 * sich aus Zeitstempel, Zähler, Maschinenkennung und einem kurzen
 * Zufallsblock zusammen — nachgemessen teilten sich die Tokens der
 * Testdatenbank einen festen Präfix, während die per CSPRNG erzeugten
 * Buchungstokens kein einziges Zeichen gemeinsam hatten. Dazu kamen Klartext
 * in der Datenbank, kein Ablauf und kein Widerruf.
 *
 * Statt das dreimal einzeln zu flicken, gibt es jetzt eine Infrastruktur. Wer
 * künftig einen öffentlichen Link braucht, nimmt sie und muss über Entropie,
 * Hashing, Ablauf und Bindung nicht mehr nachdenken.
 *
 * ---------------------------------------------------------------------------
 *  Die vier Eigenschaften, auf die es ankommt
 * ---------------------------------------------------------------------------
 *
 * **Entropie.** 32 Bytes aus dem CSPRNG, hexadezimal — 256 Bit, kein
 * Zeitanteil, kein vorhersagbarer Kopf. `randomToken()` aus `auth/jwt.ts` tut
 * genau das bereits für die Buchungslinks; eine zweite Erzeugung wäre eine
 * zweite Stelle, an der man es falsch machen kann.
 *
 * **Nur der Hash liegt in der Datenbank.** Der rohe Wert existiert bei der
 * Erzeugung, im versendeten Link und für die Dauer einer Anfrage. Wer einen
 * Datenbankabzug hat, hat keine funktionierenden Links.
 *
 * **Zweckbindung.** Ein Token für eine Rechnung öffnet keine Offerte, und ein
 * Token zum *Ansehen* einer Offerte löst keine Annahme aus. Der Zweck wird
 * beim Auflösen verlangt, nicht danach geprüft.
 *
 * **Ressourcenbindung.** Das Auflösen liefert die Ressourcen-ID; der Aufrufer
 * bekommt keine Gelegenheit, eine eigene mitzubringen. Damit gibt es kein
 * „gültiger Token A plus fremde ID B".
 *
 * ---------------------------------------------------------------------------
 *  Lebensdauer — und warum `usedAt` hier fehlt
 * ---------------------------------------------------------------------------
 *
 * `VerificationToken` entwertet sich beim ersten Gebrauch. Das ist für eine
 * Passwortzurücksetzung richtig und für fast alles hier falsch: Eine Rechnung
 * darf man zweimal ansehen, ein Signaturlink muss bis zum Abschluss wieder
 * aufrufbar sein, und eine angenommene Offerte soll ihre Bestätigung weiter
 * zeigen.
 *
 * Deshalb sind Ansehen und Handeln getrennt:
 *
 *  • **Wiederverwendbar** (`maxUses = null`) — der Normalfall. Gültig bis
 *    `expiresAt` oder `revokedAt`.
 *  • **Einmalig im Token** (`maxUses = 1`) — nur, wo die Einmaligkeit
 *    wirklich am Token hängt: beim Einmalkennwort.
 *  • **Einmalig im Geschäftszustand** — bei der Offertannahme. Der Link
 *    bleibt gültig, aber der Statusübergang findet genau einmal statt, und
 *    zwar über eine bedingte Aktualisierung in der Datenbank
 *    (`quote.service.ts`). Eine Sperre im Token wäre dort die falsche
 *    Schicht: Sie verhinderte das zweite Ansehen, nicht die zweite Annahme.
 */

/** Wie lange ein Link gilt, wenn der Aufrufer nichts anderes sagt. */
export const DEFAULT_TOKEN_TTL_DAYS = 90;

/**
 * Zu welcher Ressourcenart ein Zweck gehört.
 *
 * Steht hier und nicht als Spalte in der Datenbank: Eine zweite Angabe, die
 * dasselbe sagt, müsste synchron gehalten werden — und solche Paare laufen
 * auseinander. Diese Tabelle ist die einzige Quelle.
 */
export const PURPOSE_RESOURCE: Record<PublicTokenPurpose, string> = {
  QUOTE_VIEW: 'Quote',
  QUOTE_RESPOND: 'Quote',
  INVOICE_VIEW: 'Invoice',
  INVOICE_PAY: 'Invoice',
  BOOKING_MANAGE: 'Booking',
  DOCUMENT_VIEW: 'ManagedDocument',
  /**
   * Beide Signaturzwecke binden an den **Teilnehmer**, nicht an den Vorgang:
   * Jede unterzeichnende Person hat ihren eigenen Schlüssel, und ein Widerruf
   * trifft genau sie. In Gate 1 stand hier `SignatureRequest` — das hätte
   * einen Link für alle bedeutet.
   */
  SIGNATURE_ACCESS: 'SignatureParticipant',
  SIGNATURE_RESULT_VIEW: 'SignatureParticipant',
  /** Nicht verwendet — Einmalcodes liegen in `SignatureOtpChallenge`. */
  SIGNATURE_OTP: 'SignatureParticipant',
};

/**
 * Die Hierarchie und der Legacy-Schalter stehen in
 * `lib/auth/public-token-policy.ts` — reine Rechnung, ohne `server-only` und
 * ohne Datenbank, damit beide ohne laufende Anwendung prüfbar sind. Hier nur
 * weitergereicht, damit Aufrufer eine Anlaufstelle haben.
 */
export { legacyTokensAllowed, purposesSatisfying } from '@/lib/auth/public-token-policy';

export interface IssuedToken {
  /** Nur hier und im Link — danach nie wieder erreichbar. */
  raw: string;
  record: PublicAccessToken;
}

/**
 * Einen Link erzeugen.
 *
 * Gibt den rohen Token **einmal** zurück. Er wird bewusst nicht mit
 * protokolliert und lässt sich nicht nachträglich auslesen; ein verlorener
 * Link wird neu ausgestellt, nicht wiederhergestellt.
 */
export async function issuePublicToken(params: {
  tx?: Tx;
  organizationId: string;
  purpose: PublicTokenPurpose;
  resourceId: string;
  createdById?: string | null;
  expiresAt?: Date;
  /** Nur setzen, wo die Einmaligkeit am Token hängt (Einmalkennwort). */
  maxUses?: number;
}): Promise<IssuedToken> {
  const client = params.tx ?? prisma;

  // 32 Bytes = 256 Bit. `randomToken` liefert sie hexadezimal, also
  // URL-sicher ohne weitere Kodierung.
  const raw = randomToken(32);

  const expiresAt =
    params.expiresAt ??
    new Date(Date.now() + DEFAULT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const record = await client.publicAccessToken.create({
    data: {
      organizationId: params.organizationId,
      tokenHash: sha256Hex(raw),
      purpose: params.purpose,
      resourceId: params.resourceId,
      createdById: params.createdById ?? null,
      expiresAt,
      maxUses: params.maxUses ?? null,
    },
  });

  /**
   * Die Ausstellung gehört ins Prüfprotokoll — sie ist eine Zugangsgewährung.
   *
   * Bis hierher stand sie nur in der Tokenzeile selbst (`createdById`,
   * `createdAt`). Das genügt für die Frage „wer hat diesen Link erzeugt",
   * nicht aber für die Frage, die im Ernstfall gestellt wird: *welche
   * Zugänge sind in den letzten Tagen überhaupt vergeben worden?* Die
   * Tokenzeile verschwindet zudem mit der nächtlichen Bereinigung
   * (`cleanupExpiredTokens`); der Protokolleintrag bleibt.
   *
   * **Was hier bewusst nicht steht: der rohe Token.** Er ist der Zugang. Ein
   * Prüfprotokoll, das ihn enthielte, wäre selbst ein Schlüsselbund — und es
   * wird von anderen Personen gelesen als denen, die den Link bekommen
   * sollten. Protokolliert werden Zweck, Ressource und Frist; das reicht, um
   * eine Vergabe zu erkennen, und nicht, um sie zu benutzen.
   *
   * Der Eintrag entsteht **ausserhalb** einer etwaigen Transaktion — das ist
   * die Regel dieses Moduls (`src/lib/audit.ts`). Für eine Zugangsgewährung
   * ist die Richtung des Irrtums die richtige: Ein Eintrag zu einer
   * zurückgerollten Ausstellung führt zu einer überflüssigen Nachfrage, ein
   * fehlender Eintrag zu einer unbemerkten Vergabe.
   */
  await audit.created({
    organizationId: params.organizationId,
    userId: params.createdById ?? null,
    entity: 'PublicAccessToken',
    entityId: record.id,
    summary:
      `Zugangslink ausgestellt — Zweck ${params.purpose}, ` +
      `Ressource ${PURPOSE_RESOURCE[params.purpose]} ${params.resourceId}, ` +
      `gültig bis ${zuercherTagText(expiresAt)}` +
      (params.maxUses ? `, höchstens ${params.maxUses} Verwendung(en)` : ''),
  });

  /**
   * Derselbe Vorgang, zweimal festgehalten — und das ist kein Versehen.
   *
   * Im Prüfprotokoll steht er als Änderung an einem Datensatz: Wer hat wann
   * welchen Link erzeugt. Hier steht er als Ereignis, das jemand sehen soll:
   * Es ist gerade Zugang nach aussen gewährt worden. Beide Fragen werden von
   * verschiedenen Personen zu verschiedenen Zeiten gestellt, und ein Eintrag,
   * der beide beantworten soll, beantwortet keine gut.
   *
   * Wie oben: Zweck, Ressource, Frist. Kein Tokenwert, kein Hash.
   */
  await recordSecurityEvent({
    organizationId: params.organizationId,
    userId: params.createdById ?? null,
    kind: 'PUBLIC_LINK_ISSUED',
    summary: `Zugangslink ausgestellt — ${params.purpose}`,
    context: {
      zweck: params.purpose,
      ressource: params.resourceId,
      gueltigBis: zuercherTagText(expiresAt),
      maxVerwendungen: params.maxUses ?? null,
    },
  });

  return { raw, record };
}

/** Warum ein Link nicht (mehr) gilt — für die Meldung an die richtige Person. */
export type TokenRejection = 'UNKNOWN' | 'EXPIRED' | 'REVOKED' | 'EXHAUSTED';

export interface ResolvedToken {
  record: PublicAccessToken;
  resourceId: string;
  organizationId: string;
}

/**
 * Einen Link auflösen, ohne ihn zu verbrauchen.
 *
 * Gibt `null` zurück statt zu werfen, damit der Aufrufer entscheiden kann,
 * wie viel er verrät. Bei einem *unbekannten* Token darf nichts
 * durchscheinen — sonst liesse sich über die Antwortzeit oder den Wortlaut
 * herausfinden, welche Tokens existieren.
 */
export async function resolvePublicToken(params: {
  raw: string;
  /**
   * Der *mindestens* nötige Zweck. Stärkere Zwecke werden über
   * `purposesSatisfying` automatisch mit akzeptiert — ein `QUOTE_RESPOND`
   * öffnet also auch die Ansicht, ein `QUOTE_VIEW` löst aber keine Annahme
   * aus.
   */
  purpose: PublicTokenPurpose;
}): Promise<{ ok: true; token: ResolvedToken } | { ok: false; reason: TokenRejection }> {
  /**
   * Ein offensichtlich falsch geformter Wert wird gar nicht erst gesucht.
   *
   * 64 Hexzeichen stellt `issuePublicToken` aus. 48 sind die Buchungslinks
   * aus der Zeit vor 2026-09-27 (`randomToken(24)`), die die Migration
   * `…_buchungslink_hash` als Hash übernommen hat — bereits versendete Mails
   * sollen weiter funktionieren. 192 Bit bleiben unerratbar; eine Form
   * zuzulassen heisst nicht, einen schwächeren Weg zu öffnen, denn gefunden
   * wird ohnehin nur, was als Hash mit passendem Zweck in der Tabelle steht.
   */
  if (!/^[0-9a-f]{48}(?:[0-9a-f]{16})?$/.test(params.raw)) return { ok: false, reason: 'UNKNOWN' };

  const record = await prisma.publicAccessToken.findUnique({
    where: { tokenHash: sha256Hex(params.raw) },
  });

  // Zweck und Token werden gemeinsam geprüft, nicht nacheinander: Ein
  // Rechnungstoken, den jemand an der Offertroute vorlegt, ist hier schlicht
  // unbekannt — die Antwort verrät nicht, dass es ihn gibt.
  //
  // Und die Organisation dieser Installation gehört dazu (2026-09-27). Vorher
  // gab die Auflösung die Organisation *des Tokens* zurück, und kein Aufrufer
  // verglich sie — ein Link einer fremden Organisation öffnete, bezahlte oder
  // nahm deren Offerte hier an. Die Stelle ist die einzige, durch die jeder
  // öffentliche Link geht; hier geprüft, gilt es für alle, auch für künftige
  // Aufrufer. Ein fremder Link ist „unbekannt", nicht „abgewiesen": Er wird
  // weder gemeldet noch bestätigt.
  const erlaubt = purposesSatisfying(params.purpose);
  if (!record || !erlaubt.includes(record.purpose) || record.organizationId !== (await getOrganizationId())) {
    return { ok: false, reason: 'UNKNOWN' };
  }

  /**
   * Abgewiesene Links, die es **gibt**, werden gemeldet — geratene nicht.
   *
   * Das ist bewusst asymmetrisch und der Grund liegt nicht in der
   * Aussagekraft, sondern in der Menge. Ein Ereignis je unbekanntem Wert
   * hiesse: Wer vierstellig oft rät, schreibt vierstellig viele Zeilen in die
   * Sicherheitstabelle. Ein Protokoll, das sich von aussen füllen lässt, ist
   * ein Verstärker — es verdrängt die echten Einträge, wächst unbegrenzt und
   * kostet je Versuch eine Schreiboperation mehr als das Raten selbst.
   * Gegen das Raten steht das Rate-Limit der Route, und das ist der richtige
   * Ort dafür.
   *
   * Ein abgelaufener, widerrufener oder verbrauchter Link ist etwas anderes:
   * Er existiert, er gehört einer bekannten Organisation und einer bekannten
   * Ressource, und die Zahl solcher Ereignisse ist durch die Zahl ausgestellter
   * Links begrenzt. Er ist ausserdem die häufigste echte Kundenmeldung
   * („der Link geht nicht") — und dafür will man ihn im Protokoll haben.
   */
  const abgewiesen = async (reason: Exclude<TokenRejection, 'UNKNOWN'>, text: string) => {
    await recordSecurityEvent({
      organizationId: record.organizationId,
      kind: 'PUBLIC_LINK_REJECTED',
      summary: text,
      context: {
        zweck: record.purpose,
        ressource: record.resourceId,
        grund: reason,
      },
    });
    return { ok: false as const, reason };
  };

  if (record.revokedAt) return abgewiesen('REVOKED', 'Zurückgezogener Zugangslink vorgelegt');
  if (record.expiresAt.getTime() <= Date.now()) {
    return abgewiesen('EXPIRED', 'Abgelaufener Zugangslink vorgelegt');
  }
  if (record.maxUses !== null && record.useCount >= record.maxUses) {
    return abgewiesen('EXHAUSTED', 'Bereits verbrauchter Zugangslink vorgelegt');
  }

  return {
    ok: true,
    token: {
      record,
      resourceId: record.resourceId,
      organizationId: record.organizationId,
    },
  };
}

/**
 * Den Gebrauch festhalten.
 *
 * Getrennt vom Auflösen, weil nicht jeder Aufruf ein Gebrauch ist: Eine
 * Vorschau im Büro soll den Zähler nicht hochtreiben.
 *
 * Der Zähler wird über `increment` erhöht, nicht über „lesen und schreiben" —
 * sonst verlören gleichzeitige Aufrufe einander.
 */
export async function noteTokenUse(tokenId: string, tx?: Tx): Promise<void> {
  await (tx ?? prisma).publicAccessToken.update({
    where: { id: tokenId },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
}

/**
 * Ein Einmalkennwort verbrauchen — atomar.
 *
 * Die Bedingung steht in der `where`-Klausel, nicht in einem `if` davor: Zwei
 * gleichzeitige Prüfungen desselben Kennworts sehen sonst beide einen
 * unverbrauchten Zähler. Genau eine Aktualisierung trifft eine Zeile, die
 * andere trifft keine.
 */
export async function consumeOneTimeToken(tokenId: string, tx?: Tx): Promise<boolean> {
  const result = await (tx ?? prisma).publicAccessToken.updateMany({
    where: { id: tokenId, actionCompletedAt: null, revokedAt: null },
    data: { actionCompletedAt: new Date(), lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
  return result.count === 1;
}

/** Alle Links einer Ressource entwerten — etwa bevor neue versendet werden. */
export async function revokeTokensFor(params: {
  tx?: Tx;
  purpose: PublicTokenPurpose;
  resourceId: string;
  revokedById?: string | null;
}): Promise<number> {
  const result = await (params.tx ?? prisma).publicAccessToken.updateMany({
    where: { purpose: params.purpose, resourceId: params.resourceId, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: params.revokedById ?? null },
  });
  return result.count;
}

/**
 * Eine Ressource über den neuen *oder* den alten Weg auflösen.
 *
 * Der Rückgabewert sagt, welcher Weg es war. Aufrufer, die eine abschliessende
 * Handlung ausführen, dürfen `legacy` ablehnen; Aufrufer, die nur anzeigen,
 * nicht.
 */
export async function resolveWithLegacy(params: {
  raw: string;
  purpose: PublicTokenPurpose;
  /** Sucht die Ressource über das alte Klartextfeld. */
  legacyLookup: (raw: string) => Promise<{ id: string; organizationId: string } | null>;
  /**
   * Darf für *diesen* Aufruf überhaupt auf den alten Weg zurückgefallen
   * werden?
   *
   * Abschliessende Handlungen — Offerte annehmen oder ablehnen, Zahlung
   * starten — setzen `false` und verlangen damit einen echten Token,
   * unabhängig davon, wie die Umgebungseinstellung steht. Ansehen darf
   * zurückfallen, Handeln nicht: Das eine ist eine Unbequemlichkeit für die
   * Kundschaft, das andere eine Zustandsänderung, die sich nicht
   * zurücknehmen lässt.
   */
  allowLegacy?: boolean;
}): Promise<
  | { ok: true; resourceId: string; organizationId: string; legacy: boolean; tokenId?: string }
  | { ok: false; reason: TokenRejection }
> {
  const neu = await resolvePublicToken({ raw: params.raw, purpose: params.purpose });
  if (neu.ok) {
    return {
      ok: true,
      resourceId: neu.token.resourceId,
      organizationId: neu.token.organizationId,
      legacy: false,
      tokenId: neu.token.record.id,
    };
  }

  // Abgelaufen oder widerrufen bleibt abgelaufen oder widerrufen — ein alter
  // Link darf einen bewusst entwerteten neuen nicht wiederbeleben.
  if (neu.reason !== 'UNKNOWN') return neu;

  if (params.allowLegacy === false) return { ok: false, reason: 'UNKNOWN' };
  if (!legacyTokensAllowed()) return { ok: false, reason: 'UNKNOWN' };

  const alt = await params.legacyLookup(params.raw);
  if (!alt) return { ok: false, reason: 'UNKNOWN' };

  return { ok: true, resourceId: alt.id, organizationId: alt.organizationId, legacy: true };
}

/**
 * Die Meldung für eine abgelehnte Anfrage.
 *
 * Ein unbekannter Token bekommt bewusst dieselbe Antwort wie eine gelöschte
 * oder fremde Ressource: „gibt es nicht". Alles andere beantwortete die
 * Frage, ob ein geratener Wert existiert.
 *
 * Abgelaufen und widerrufen dürfen dagegen erklärt werden — wer sie sieht,
 * hatte einen echten Link in der Hand, und eine hilfreiche Meldung erspart
 * ihm den Anruf.
 */
export function tokenRejectionError(reason: TokenRejection, resource: string): NotFoundError {
  switch (reason) {
    case 'EXPIRED':
      return new NotFoundError(`${resource} — der Link ist abgelaufen`);
    case 'REVOKED':
      return new NotFoundError(`${resource} — der Link wurde zurückgezogen`);
    case 'EXHAUSTED':
      return new NotFoundError(`${resource} — der Link wurde bereits verwendet`);
    default:
      return new NotFoundError(resource);
  }
}
