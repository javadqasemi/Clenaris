import { z } from 'zod';

/**
 * Die Konfiguration je Aktionsart.
 *
 * ---------------------------------------------------------------------------
 *  Warum das nachgeholt werden musste
 * ---------------------------------------------------------------------------
 *
 * `automationActionSchema` in `operations-admin.ts` nimmt `config` als
 * `z.record(z.unknown())` entgegen — also alles. Solange die Regeln nie liefen,
 * war das folgenlos: Ein Feld, das niemand liest, kann nichts anrichten.
 *
 * Mit der Automatisierungsmaschine ändert sich das grundlegend. `config`
 * bestimmt jetzt, an wen eine E-Mail geht, welcher Datensatz seinen Status
 * ändert und welche Adresse aufgerufen wird. Ein unvalidiertes Feld wäre damit
 * eine Eingabemaske für alles, was der Server tun kann — für jede Person mit
 * `automation:update`, also auch für die Betriebsleitung.
 *
 * Deshalb: je Aktionsart ein eigenes Schema, geprüft **beim Anlegen** und
 * noch einmal **beim Ausführen**. Zweimal, weil eine Regel im Bestand aus der
 * Zeit vor dieser Prüfung stammen kann; die Maschine setzt sie dann auf
 * `SKIPPED` mit Begründung, statt eine unverstandene Konfiguration auszuführen.
 */

/**
 * Empfänger einer Nachricht.
 *
 * **Keine freie Adresse.** Die naheliegende Bequemlichkeit — ein Feld
 * `email`, in das jemand schreibt, wohin die Nachricht gehen soll — wäre ein
 * Versandkanal für Beliebiges: Wer eine Regel anlegen darf, könnte jeden
 * Vorgang an eine fremde Adresse schicken lassen, mit den Daten des Vorgangs
 * darin. Der Empfänger ergibt sich deshalb aus der **Rolle im Vorgang**.
 */
export const EMPFAENGER = ['CUSTOMER', 'ASSIGNED_EMPLOYEE', 'MANAGEMENT'] as const;
export type Empfaenger = (typeof EMPFAENGER)[number];

const empfaengerSchema = z.enum(EMPFAENGER);

/**
 * Ein Vorlagenschlüssel, keine freie Nachricht.
 *
 * Aus demselben Grund: Freier Text in einer automatisch versendeten Nachricht
 * wäre eine Möglichkeit, im Namen des Betriebs beliebiges zu verschicken —
 * und zwar an die echte Kundschaft, mit dem echten Absender. Die Vorlagen
 * liegen in `EmailTemplate`/`SmsTemplate` und durchlaufen die Redaktion.
 */
const vorlagenSchluessel = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9_]+$/, 'Nur Kleinbuchstaben, Ziffern und Unterstriche.');

export const sendEmailConfigSchema = z.object({
  templateKey: vorlagenSchluessel,
  empfaenger: empfaengerSchema.default('CUSTOMER'),
});

export const sendSmsConfigSchema = z.object({
  templateKey: vorlagenSchluessel,
  empfaenger: empfaengerSchema.default('CUSTOMER'),
});

export const createTaskConfigSchema = z.object({
  titel: z.string().trim().min(3).max(200),
  beschreibung: z.string().trim().max(1000).optional(),
  /** Tage ab Ausführung bis zur Fälligkeit. */
  faelligInTagen: z.number().int().min(0).max(365).default(0),
  // Die Werte stammen aus `TaskPriority` im Schema — dort heisst die mittlere
  // Stufe `NORMAL` und nicht `MEDIUM`. Eine eigene Benennung hier wäre eine
  // Übersetzung, die beim nächsten neuen Wert einseitig gepflegt wird.
  prioritaet: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
});

export const createNotificationConfigSchema = z.object({
  titel: z.string().trim().min(3).max(200),
  text: z.string().trim().max(1000).optional(),
  empfaenger: z.enum(['ASSIGNED_EMPLOYEE', 'MANAGEMENT']).default('MANAGEMENT'),
});

/**
 * Statusänderungen — und die Liste ist die ganze Sicherheitsmassnahme.
 *
 * Ohne sie hiesse `UPDATE_STATUS`: „schreibe in ein beliebiges Feld eines
 * beliebigen Datensatzes einen beliebigen Wert". Das ist keine Automatisierung
 * mehr, das ist ein Datenbankzugang über ein Formular.
 *
 * Erlaubt sind genau die Übergänge, die auch von Hand über die Oberfläche
 * gehen und keine Folgewirkung haben, die geprüft werden müsste. **Nicht
 * dabei und nicht nachträglich hinzuzufügen:** alles Finanzielle. Eine
 * Rechnung wird nicht automatisch ausgestellt, storniert oder bezahlt gesetzt
 * — Belegnummern sind lückenlos zu vergeben (Art. 957a OR), und eine
 * ausgestellte Rechnung ist unveränderlich. Dasselbe gilt für den Abschluss
 * einer Unterschrift.
 */
export const ERLAUBTE_STATUSAENDERUNGEN = {
  lead: ['CONTACTED', 'QUALIFIED', 'LOST'],
  booking: ['CONFIRMED', 'CANCELLED'],
  job: ['UNASSIGNED', 'CANCELLED'],
} as const;

export type StatusZiel = keyof typeof ERLAUBTE_STATUSAENDERUNGEN;

/**
 * Aus welchem Zustand eine Regel wechseln darf (2026-09-28, B-19).
 *
 * Die Liste oben begrenzte nur das **Ziel**. Geschrieben wurde ohne
 * Bedingung — eine Regel „bei … Einsatz auf offen setzen" holte damit einen
 * abgesagten Einsatz zurück, samt altem Team und ohne die
 * Überschneidungsprüfung der Zuteilung (`assignment.service.ts`), und eine
 * Regel „absagen" traf auch einen abgeschlossenen oder geprüften Einsatz —
 * die Grundlage der Verrechnung. Von Hand ginge beides nicht.
 *
 * Jetzt nur aus Zuständen, in denen der Übergang auch von Hand ohne weitere
 * Folgen ginge: nichts Begonnenes, nichts Abgeschlossenes, nichts Abgesagtes
 * zurück. Der Zustand steht im `where` der Änderung, also entscheidet die
 * Datenbank im Moment des Schreibens — nicht eine Lektüre davor.
 */
export const ERLAUBTE_AUSGANGSZUSTAENDE: {
  [Z in StatusZiel]: Record<(typeof ERLAUBTE_STATUSAENDERUNGEN)[Z][number], readonly string[]>;
} = {
  lead: {
    CONTACTED: ['NEW'],
    QUALIFIED: ['NEW', 'CONTACTED'],
    LOST: ['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL'],
  },
  booking: {
    CONFIRMED: ['PENDING'],
    CANCELLED: ['PENDING', 'CONFIRMED'],
  },
  job: {
    UNASSIGNED: ['SCHEDULED', 'DISPATCHED', 'ON_HOLD'],
    CANCELLED: ['UNASSIGNED', 'SCHEDULED', 'DISPATCHED', 'ON_HOLD'],
  },
};

/** Die zulässigen Ausgangszustände für `ziel` → `status`; leer, wenn der Wechsel nicht zugelassen ist. */
export function ausgangszustaendeFuer(ziel: string, status: string): readonly string[] {
  const jeZiel = (ERLAUBTE_AUSGANGSZUSTAENDE as Record<string, Record<string, readonly string[]>>)[ziel];
  return jeZiel?.[status] ?? [];
}

export const updateStatusConfigSchema = z
  .object({
    ziel: z.enum(['lead', 'booking', 'job']),
    status: z.string().trim().min(2).max(40),
  })
  .superRefine((wert, ctx) => {
    const erlaubt = ERLAUBTE_STATUSAENDERUNGEN[wert.ziel] as readonly string[];
    if (!erlaubt.includes(wert.status)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `Für „${wert.ziel}" sind nur diese Werte zulässig: ${erlaubt.join(', ')}.`,
      });
    }
  });

/**
 * Der ausgehende Aufruf — die gefährlichste Aktion, und deshalb die engste.
 *
 * ---------------------------------------------------------------------------
 *  Warum eine Adresse nicht einfach eine Adresse ist
 * ---------------------------------------------------------------------------
 *
 * Ein Webhook ist ein Aufruf, den **der Server** ausführt. Er läuft damit aus
 * dem Netz des Servers heraus — und in dieses Netz hinein. Das ist die
 * klassische serverseitige Anfragefälschung (SSRF): Wer die Adresse bestimmen
 * darf, erreicht damit alles, was der Server erreicht, einschliesslich
 * Dinge, die von aussen nicht erreichbar sind — die Datenbank, der
 * Metadatendienst der Cloud, der Verwaltungszugang des Nachbardienstes.
 *
 * Die Prüfung hier ist die erste Hälfte (Form und Schema). Die zweite Hälfte
 * steht in `automation-engine.service.ts` und ist die wichtigere: Dort wird
 * der aufgelöste Name gegen private Adressbereiche gehalten, **nachdem** er
 * aufgelöst wurde. Eine Prüfung allein über die Zeichenkette wäre wirkungslos,
 * denn ein Name im öffentlichen DNS darf auf `127.0.0.1` zeigen, und viele
 * tun es.
 */
export const webhookConfigSchema = z.object({
  url: z
    .string()
    .trim()
    .url('Bitte eine vollständige Adresse angeben.')
    .max(500)
    .refine((u) => u.startsWith('https://'), {
      message:
        'Nur https. Über http ginge der Inhalt des Vorgangs im Klartext durch fremde Netze.',
    })
    // Nur der Standardport (2026-09-27, N-10) — dieselbe Regel wie
    // `WEBHOOK_PORT` in `lib/automation/webhook.ts`, hier nachgebildet, weil
    // diese Datei auch im Browser läuft und jene Node-Module lädt. Ohne sie
    // nahm die Maske `:8443` an, und die Regel scheiterte erst beim Ausführen.
    .refine((u) => { try { return ['', '443'].includes(new URL(u).port); } catch { return false; } }, {
      message: 'Nur der Standardport 443. Andere Ports erreichen oft interne Dienste statt einer Webhook-Gegenstelle.',
    }),
  /**
   * Ein gemeinsames Geheimnis, mit dem die Gegenstelle prüfen kann, dass der
   * Aufruf von uns stammt. Wird als HMAC über den Rumpf mitgeschickt, **nie
   * im Klartext** — ein Geheimnis in einer Kopfzeile ist ein Geheimnis in
   * jedem Protokoll dazwischen.
   */
  secret: z.string().trim().min(16).max(200).optional(),
});

export const aiGenerateConfigSchema = z.object({
  /** Was erzeugt werden soll — die Vorlage steckt im Dienst, nicht hier. */
  zweck: z.enum(['FOLLOW_UP_MAIL', 'REVIEW_REPLY', 'JOB_SUMMARY']),
  /** Wohin das Ergebnis geht. Nie direkt nach aussen. */
  ablage: z.enum(['TASK', 'NOTIFICATION']).default('TASK'),
});

/**
 * Die Zuordnung Aktionsart → Schema.
 *
 * Als Tabelle und nicht als `switch`: Eine neue Aktionsart ohne Eintrag fällt
 * hier sofort auf (der Typ verlangt Vollständigkeit), während ein `switch`
 * ohne `default` sie stillschweigend durchliesse.
 */
export const AKTIONS_KONFIGURATION = {
  SEND_EMAIL: sendEmailConfigSchema,
  SEND_SMS: sendSmsConfigSchema,
  CREATE_TASK: createTaskConfigSchema,
  CREATE_NOTIFICATION: createNotificationConfigSchema,
  UPDATE_STATUS: updateStatusConfigSchema,
  WEBHOOK: webhookConfigSchema,
  AI_GENERATE: aiGenerateConfigSchema,
} as const;

export type AktionsArt = keyof typeof AKTIONS_KONFIGURATION;

export interface KonfigurationsBefund {
  ok: boolean;
  /** Nur bei `ok: false` — eine Meldung, die sagt, was fehlt. */
  grund?: string;
}

/**
 * Eine Aktionskonfiguration prüfen, ohne zu werfen.
 *
 * Der Ausführungspfad braucht eine Antwort und keine Ausnahme: Eine
 * unverstandene Konfiguration endet als `SKIPPED` mit Begründung, nicht als
 * abgebrochener Lauf, der die folgenden Aktionen mitnimmt.
 */
export function pruefeAktionsKonfiguration(
  art: string,
  config: unknown,
): KonfigurationsBefund {
  const schema = AKTIONS_KONFIGURATION[art as AktionsArt];
  if (!schema) return { ok: false, grund: `Unbekannte Aktionsart „${art}".` };

  const ergebnis = schema.safeParse(config ?? {});
  if (ergebnis.success) return { ok: true };

  return {
    ok: false,
    grund: ergebnis.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; '),
  };
}
