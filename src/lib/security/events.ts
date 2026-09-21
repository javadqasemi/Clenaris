import type { SecurityCategory, SecuritySeverity } from '@prisma/client';

/**
 * Der Katalog der Sicherheitsereignisse.
 *
 * ---------------------------------------------------------------------------
 *  Warum die Art eine Zeichenkette ist und kein Aufzählungstyp
 * ---------------------------------------------------------------------------
 *
 * Ein `enum` in der Datenbank wäre sauberer und hätte einen Preis, den man
 * erst später bezahlt: Jede neue Ereignisart bräuchte eine Migration. Wer im
 * laufenden Betrieb eine Stelle absichert und dabei ein Ereignis mitschreiben
 * will, schreibt dann keines — nicht aus Nachlässigkeit, sondern weil der
 * Aufwand grösser ist als der Nutzen im Moment. Genau so entstehen
 * Sicherheitsprotokolle mit Lücken.
 *
 * Die Typsicherheit geht dabei nicht verloren, sie wandert nur hierher:
 * `SecurityEventKind` ist die Vereinigung der Schlüssel dieses Katalogs, und
 * `recordSecurityEvent` nimmt nichts anderes an. Eine unbekannte Art lässt
 * sich nicht schreiben, ohne sie hier einzutragen — und beim Eintragen muss
 * man Kategorie und Schwere benennen, also einen Moment nachdenken.
 *
 * ---------------------------------------------------------------------------
 *  Was die Schwere bedeutet
 * ---------------------------------------------------------------------------
 *
 * `CRITICAL` heisst **nicht** „schlimm", sondern „braucht eine Entscheidung
 * eines Menschen". Eine gesperrte Anmeldung ist nicht schlimm — die Sperre hat
 * ja funktioniert — aber jemand sollte wissen, dass sie zugeschlagen hat.
 * Umgekehrt ist ein erfolgreicher Login nicht harmlos, weil er alltäglich ist;
 * er ist `INFO`, weil sich daraus einzeln nichts entscheiden lässt.
 *
 * Die Stufe steuert nur die Anzeige und die Frage, ob ein Ereignis bestätigt
 * werden will. Ob überhaupt protokolliert wird, entscheidet die Stelle, die
 * das Ereignis auslöst — niemals die Stufe.
 */

interface EreignisArt {
  category: SecurityCategory;
  severity: SecuritySeverity;
  /** Kurzbezeichnung für die Übersicht. Deutsch, ohne Codebegriffe. */
  label: string;
}

export const SECURITY_EVENTS = {
  // --- Anmeldung -----------------------------------------------------------

  LOGIN_SUCCEEDED: {
    category: 'AUTHENTICATION',
    severity: 'INFO',
    label: 'Anmeldung erfolgreich',
  },
  /**
   * Ein einzelner Fehlversuch ist `WARNING` und nicht `INFO`: Er ist der
   * einzige Baustein, aus dem sich ein Angriffsmuster zusammensetzen lässt,
   * und wer die Übersicht nach Auffälligem filtert, will ihn sehen. Die
   * Häufung — nicht der Einzelfall — führt zu `ACCOUNT_LOCKED`.
   */
  LOGIN_FAILED: {
    category: 'AUTHENTICATION',
    severity: 'WARNING',
    label: 'Anmeldung fehlgeschlagen',
  },
  /**
   * Eine Anmeldung auf ein Konto, das gesperrt oder stillgelegt ist. Getrennt
   * von `LOGIN_FAILED`, weil es etwas anderes bedeutet: Hier stimmt vielleicht
   * sogar das Passwort, und trotzdem kommt niemand herein.
   */
  LOGIN_BLOCKED: {
    category: 'AUTHENTICATION',
    severity: 'WARNING',
    label: 'Anmeldung abgewiesen — Konto gesperrt oder stillgelegt',
  },
  ACCOUNT_LOCKED: {
    category: 'AUTHENTICATION',
    severity: 'CRITICAL',
    label: 'Konto nach Fehlversuchen gesperrt',
  },
  TWO_FACTOR_FAILED: {
    category: 'AUTHENTICATION',
    severity: 'WARNING',
    label: 'Zweiter Faktor falsch',
  },
  TWO_FACTOR_ENABLED: {
    category: 'AUTHENTICATION',
    severity: 'INFO',
    label: 'Zweiter Faktor eingeschaltet',
  },
  /**
   * `CRITICAL`, obwohl es eine reguläre Handlung ist. Das Abschalten des
   * zweiten Faktors ist der erste Schritt, den jemand geht, der ein Konto
   * übernommen hat — und der letzte, den die rechtmässige Person bemerkt.
   */
  TWO_FACTOR_DISABLED: {
    category: 'AUTHENTICATION',
    severity: 'CRITICAL',
    label: 'Zweiter Faktor abgeschaltet',
  },
  PASSWORD_CHANGED: {
    category: 'AUTHENTICATION',
    severity: 'INFO',
    label: 'Passwort geändert',
  },
  PASSWORD_RESET_REQUESTED: {
    category: 'AUTHENTICATION',
    severity: 'WARNING',
    label: 'Passwort-Zurücksetzung angefordert',
  },

  // --- Sitzungen -----------------------------------------------------------

  /**
   * Ein Erneuerungstoken wurde ein zweites Mal vorgelegt. Der erste Gebrauch
   * hat ihn verbraucht — ein zweiter heisst, dass jemand eine Kopie hat.
   * Die Rotationsfamilie wird deshalb ganz widerrufen, und das gehört gesehen.
   */
  REFRESH_REUSE_DETECTED: {
    category: 'SESSION',
    severity: 'CRITICAL',
    label: 'Erneuerungstoken mehrfach verwendet',
  },
  SESSIONS_REVOKED: {
    category: 'SESSION',
    severity: 'WARNING',
    label: 'Alle Sitzungen widerrufen',
  },
  DEVICE_HANDOFF_STARTED: {
    category: 'SESSION',
    severity: 'INFO',
    label: 'Gerät übergeben — Sitzung gesperrt',
  },
  DEVICE_HANDOFF_RELEASED: {
    category: 'SESSION',
    severity: 'INFO',
    label: 'Gerät wieder freigegeben',
  },

  // --- Zugriff -------------------------------------------------------------

  /**
   * Bewusst `WARNING` und nicht `CRITICAL`. Ein abgelehnter Zugriff ist der
   * Normalfall einer funktionierenden Rechteprüfung — jemand klickt auf einen
   * Link, den er sich gemerkt hat, und bekommt eine Absage. Erst die Häufung
   * auf ein Konto oder eine Adresse ist eine Aussage, und die trifft die
   * Übersicht, nicht der einzelne Eintrag.
   */
  ACCESS_DENIED: {
    category: 'ACCESS',
    severity: 'WARNING',
    label: 'Zugriff abgelehnt',
  },
  ROLE_ASSIGNED: {
    category: 'ACCESS',
    severity: 'CRITICAL',
    label: 'Rolle geändert',
  },
  USER_SUSPENDED: {
    category: 'ACCESS',
    severity: 'WARNING',
    label: 'Konto stillgelegt',
  },
  USER_REACTIVATED: {
    category: 'ACCESS',
    severity: 'WARNING',
    label: 'Konto wieder aktiviert',
  },

  // --- Öffentliche Links ---------------------------------------------------

  PUBLIC_LINK_ISSUED: {
    category: 'PUBLIC_LINK',
    severity: 'INFO',
    label: 'Zugangslink ausgestellt',
  },
  /**
   * Ein vorgelegter Link, den es **gibt** und der trotzdem nicht trägt:
   * abgelaufen, widerrufen, verbraucht.
   *
   * **Ein unbekannter Wert erzeugt ausdrücklich kein Ereignis.** Sonst
   * schriebe jeder Rateversuch eine Zeile, und ein Protokoll, das sich von
   * aussen füllen lässt, verdrängt genau die Einträge, für die es da ist.
   * Gegen das Raten steht das Rate-Limit der Route. Die Begründung steht
   * ausführlich in `access-token.service.ts`.
   */
  PUBLIC_LINK_REJECTED: {
    category: 'PUBLIC_LINK',
    severity: 'WARNING',
    label: 'Zugangslink abgewiesen',
  },
  PUBLIC_LINK_REVOKED: {
    category: 'PUBLIC_LINK',
    severity: 'INFO',
    label: 'Zugangslink widerrufen',
  },

  // --- Dateien -------------------------------------------------------------

  FILE_SCAN_INFECTED: {
    category: 'FILE',
    severity: 'CRITICAL',
    label: 'Schadsoftware in einer Datei gefunden',
  },
  /**
   * Quarantäne aus einem anderen Grund als einem Fund — vor allem, wenn sich
   * die gespeicherten Bytes zwischen Abschluss und Prüfung geändert haben.
   * Das ist der schwerere der beiden Fälle: Ein Fund heisst, der Prüfer hat
   * gearbeitet; veränderte Bytes heissen, jemand hatte Zugriff auf die Ablage.
   */
  FILE_QUARANTINED: {
    category: 'FILE',
    severity: 'CRITICAL',
    label: 'Datei in Quarantäne',
  },
  /**
   * Der Prüfer konnte nichts sagen — und zwar endgültig, nach dem letzten
   * Versuch. Ein einzelner Fehlschlag mitten in der Reihe erzeugt kein
   * Ereignis; sonst meldet ein kurzer Netzaussetzer hundert Zeilen.
   */
  FILE_SCAN_UNAVAILABLE: {
    category: 'FILE',
    severity: 'WARNING',
    label: 'Prüfer nicht erreichbar — Datei bleibt gesperrt',
  },
  FILE_POLICY_REJECTED: {
    category: 'FILE',
    severity: 'WARNING',
    label: 'Datei wegen Name, Endung oder Typ abgewiesen',
  },

  // --- Betriebszustand -----------------------------------------------------

  /**
   * Die Anwendung nimmt Dateien an und kann keine prüfen. Ein Zustand, den
   * niemand absichtlich herstellt und der sich nur beim Start zeigt.
   */
  SCANNER_MISSING: {
    category: 'SYSTEM',
    severity: 'CRITICAL',
    label: 'Kein Schadsoftwareprüfer eingerichtet',
  },
  SECURITY_EVENT_ACKNOWLEDGED: {
    category: 'SYSTEM',
    severity: 'INFO',
    label: 'Sicherheitsereignis bestätigt',
  },
} as const satisfies Record<string, EreignisArt>;

export type SecurityEventKind = keyof typeof SECURITY_EVENTS;

/** Alle Arten einer Kategorie — für Filter und für die Prüfreihe. */
export function artenDerKategorie(kategorie: SecurityCategory): SecurityEventKind[] {
  return (Object.keys(SECURITY_EVENTS) as SecurityEventKind[]).filter(
    (k) => SECURITY_EVENTS[k].category === kategorie,
  );
}

/**
 * Arten, die eine Bestätigung verlangen.
 *
 * Die Regel steht hier und nicht an der Anzeige: Sonst entschiede die
 * Oberfläche, was als erledigt gilt, und eine zweite Oberfläche entschiede es
 * anders.
 */
export function verlangtBestaetigung(kind: SecurityEventKind): boolean {
  return SECURITY_EVENTS[kind].severity === 'CRITICAL';
}
