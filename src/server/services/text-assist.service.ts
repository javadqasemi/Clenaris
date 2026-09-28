import 'server-only';

import { randomBytes } from 'node:crypto';

import { generateText, modelFor } from '@/lib/ai/client';
import {
  aktionLabel,
  antwortAuswerten,
  ergebnisZurueck,
  gesperrteInhalte,
  sperrMeldung,
  textAssistNutzlast,
} from '@/lib/ai/text-assist';
import { hasIntegration } from '@/lib/env';
import { AppError, BusinessRuleError, ConfigurationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { TextAssistInput } from '@/lib/validation/ai';
import { protokolliereKiNutzung } from '@/server/services/ai-governance.service';

const log = logger('ai');

/**
 * KI-Textassistent (2026-09-28) — Korrektur und Vorschläge für Texte in
 * Website-, Blog-, SEO-, Leistungs- und Offertmasken.
 *
 * **Die Reihenfolge ist die Sicherheitsaussage:**
 *
 *  1. Sperrprüfung (`gesperrteInhalte`). Steht eine AHV-Nummer, IBAN, ein
 *     Zugangs-/Alarmcode, ein Passwort, ein Lohnbetrag oder ein Token im
 *     Text, endet die Anfrage hier mit 422 — **vor** der Frage, ob der
 *     Anbieter eingerichtet ist. So antwortet die Prüfung mit und ohne
 *     Schlüssel gleich, und die Prüfreihe kann sie ohne Anbieter belegen.
 *  2. Anbieter eingerichtet? Sonst 503 mit klarer Meldung (`ConfigurationError`
 *     statt des generischen `IntegrationError` aus `anthropic()`: Ein fehlender
 *     Schlüssel ist keine Störung, „später erneut versuchen" hilft nie).
 *  3. Nutzlast mit Schutzplatzhaltern (`textAssistNutzlast`), dann der Client
 *     mit seinem Ausgangsfilter, schnelles Modell, kurze Zeitgrenze, keine
 *     Werkzeuge (`generateText` bietet dem Modell keine an).
 *  4. Antwort prüfen (`antwortAuswerten`), geschützte Werte einsetzen.
 *  5. Protokoll **nur mit Metadaten** — Aktion, Feldart, Längen, Modell,
 *     Dauer, Anzahl geschützter Stellen. Weder Eingabe noch Ergebnis, weder
 *     im Prüfprotokoll noch im Log.
 *
 * Geschrieben wird nichts ausser dem Protokolleintrag: Der Vorschlag geht
 * ans Formular, und gespeichert wird erst, wenn die Person das Formular
 * speichert.
 */

/** Zeitgrenze je Anfrage. Wer im offenen Formular wartet, soll nach Sekunden eine klare Meldung sehen. */
const ZEITGRENZE_MS = 45_000;

export interface TextAssistAntwort {
  format: 'text' | 'vorschlaege';
  text?: string;
  vorschlaege?: string[];
  /** Stellen, die nicht an die KI gingen und unverändert blieben. */
  geschuetzt: number;
}

export async function textAssistieren(
  eingabe: TextAssistInput,
  kontext: { organizationId: string; userId: string; ip?: string | null },
): Promise<TextAssistAntwort> {
  const gesperrt = gesperrteInhalte(eingabe.text);
  if (gesperrt.length > 0) {
    // Gezählt wird die Kategorie, nie der Wert — und nicht im Prüfprotokoll:
    // Eine abgewiesene Anfrage ist keine Nutzung.
    log.info('KI-Textassistent: Anfrage wegen vertraulicher Angabe abgewiesen', { kategorien: gesperrt });
    throw new BusinessRuleError(sperrMeldung(gesperrt));
  }

  if (!hasIntegration('ai')) {
    throw new ConfigurationError(
      'Anthropic',
      'Der KI-Textassistent ist nicht eingerichtet: Es ist kein KI-Anbieter konfiguriert (ANTHROPIC_API_KEY). Der Text bleibt unverändert.',
    );
  }

  const nutzlast = textAssistNutzlast({
    aktion: eingabe.aktion,
    kontext: eingabe.kontext,
    text: eingabe.text,
    kennung: randomBytes(8).toString('hex'),
  });

  const beginn = Date.now();
  let roh: string;
  try {
    roh = await generateText({
      system: nutzlast.system,
      prompt: nutzlast.prompt,
      tier: 'fast',
      effort: 'low',
      maxTokens: 4_000,
      timeoutMs: ZEITGRENZE_MS,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Nur der Fehlertyp ins Log — die Meldung des SDK kann Teile der Anfrage zitieren.
    log.warn('KI-Textassistent: Anbieter nicht erreichbar', { fehler: error instanceof Error ? error.name : 'unbekannt' });
    throw new AppError(
      'INTEGRATION_ERROR',
      'Die KI hat nicht rechtzeitig geantwortet. Der Text bleibt unverändert — bitte versuchen Sie es erneut.',
      502,
      { expose: true, cause: error },
    );
  }

  const ergebnis = ergebnisZurueck(
    antwortAuswerten(roh, nutzlast.format, { eingabeLaenge: eingabe.text.length, aktion: eingabe.aktion }),
    nutzlast.zurueck,
  );
  if (!ergebnis.ok || (ergebnis.format === 'vorschlaege' && ergebnis.vorschlaege.length === 0)) {
    log.warn('KI-Textassistent: unbrauchbare Antwort verworfen', { grund: ergebnis.ok ? 'leer' : ergebnis.grund });
    throw new AppError(
      'INTEGRATION_ERROR',
      'Die KI hat keinen brauchbaren Vorschlag geliefert. Bitte erneut generieren.',
      502,
      { expose: true },
    );
  }

  const ausgabeLaenge = ergebnis.format === 'text' ? ergebnis.text.length : ergebnis.vorschlaege.join('').length;
  await protokolliereKiNutzung({
    organizationId: kontext.organizationId,
    userId: kontext.userId,
    funktion: 'Textassistent',
    ip: kontext.ip,
    details: {
      aktion: eingabe.aktion,
      aktionLabel: aktionLabel(eingabe.aktion),
      kontext: eingabe.kontext,
      zeichenEingabe: eingabe.text.length,
      zeichenAusgabe: ausgabeLaenge,
      geschuetzteStellen: nutzlast.geschuetzt,
      modell: modelFor('fast'),
      dauerMs: Date.now() - beginn,
    },
  });

  return ergebnis.format === 'text'
    ? { format: 'text', text: ergebnis.text, geschuetzt: nutzlast.geschuetzt }
    : { format: 'vorschlaege', vorschlaege: ergebnis.vorschlaege, geschuetzt: nutzlast.geschuetzt };
}
