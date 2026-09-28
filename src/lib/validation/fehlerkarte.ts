import { z, ZodIssueCode, type ZodErrorMap } from 'zod';

/**
 * Deutsche Standardmeldungen für Zod.
 *
 * **Warum es diese Datei gibt.** Die Schemas tragen eigene Meldungen dort, wo
 * jemand an sie gedacht hat („Bitte geben Sie einen Titel an."). Überall
 * sonst meldete Zod auf Englisch — und zwar genau in den Fällen, an die
 * niemand gedacht hatte. Gefunden am 2026-09-28: Die Offerte liess sich nicht
 * speichern, und in der Maske stand „Expected string, received date". Eine
 * englische Meldung in einem deutschsprachigen Produkt ist nicht bloss
 * unschön; sie ist für die Person davor unverständlich und damit keine
 * Fehlermeldung, sondern ein zweiter Fehler.
 *
 * **Wo sie wirkt.** `z.setErrorMap` gilt für die ganze Zod-Instanz eines
 * Bündels. Eingehängt wird sie an den zwei Toren, durch die jede Prüfung
 * läuft — in der Routenfabrik (`lib/api/handler.ts`, Server) und im
 * Formularbaustein (`components/ui/form.tsx`, Browser) — und zusätzlich in
 * `common.ts`, das die meisten Schemas ohnehin laden. Eine Meldung, die ein
 * Schema selbst setzt, hat immer Vorrang: Die Karte liefert nur die Vorgabe
 * (`ctx.defaultError` wird ersetzt, `message` am Schema nicht).
 *
 * Die Formulierungen folgen dem Ton der eigenen Meldungen: höflich, konkret,
 * ohne Fachbegriffe wie „Typ" oder „String".
 */
export const deutscheFehlerkarte: ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === 'undefined' || issue.received === 'null') {
        return { message: 'Bitte füllen Sie dieses Feld aus.' };
      }
      if (issue.expected === 'number' || issue.expected === 'integer') {
        return { message: 'Bitte geben Sie eine Zahl an.' };
      }
      if (issue.expected === 'date') return { message: 'Bitte geben Sie ein gültiges Datum an.' };
      if (issue.expected === 'boolean') return { message: 'Bitte wählen Sie Ja oder Nein.' };
      return { message: 'Dieser Wert hat nicht das erwartete Format.' };

    case ZodIssueCode.too_small:
      if (issue.type === 'string') {
        return {
          message:
            issue.minimum === 1
              ? 'Bitte füllen Sie dieses Feld aus.'
              : `Bitte geben Sie mindestens ${issue.minimum} Zeichen ein.`,
        };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return {
          message: issue.inclusive
            ? `Der Wert muss mindestens ${issue.minimum} betragen.`
            : `Der Wert muss grösser als ${issue.minimum} sein.`,
        };
      }
      if (issue.type === 'array' || issue.type === 'set') {
        return { message: `Bitte wählen Sie mindestens ${issue.minimum} Einträge.` };
      }
      if (issue.type === 'date') return { message: 'Das Datum liegt zu früh.' };
      return { message: 'Dieser Wert ist zu klein.' };

    case ZodIssueCode.too_big:
      if (issue.type === 'string') {
        return { message: `Bitte geben Sie höchstens ${issue.maximum} Zeichen ein.` };
      }
      if (issue.type === 'number' || issue.type === 'bigint') {
        return {
          message: issue.inclusive
            ? `Der Wert darf höchstens ${issue.maximum} betragen.`
            : `Der Wert muss kleiner als ${issue.maximum} sein.`,
        };
      }
      if (issue.type === 'array' || issue.type === 'set') {
        return { message: `Bitte wählen Sie höchstens ${issue.maximum} Einträge.` };
      }
      if (issue.type === 'date') return { message: 'Das Datum liegt zu spät.' };
      return { message: 'Dieser Wert ist zu gross.' };

    case ZodIssueCode.invalid_string:
      if (issue.validation === 'email') return { message: 'Bitte geben Sie eine gültige E-Mail-Adresse an.' };
      if (issue.validation === 'url') return { message: 'Bitte geben Sie eine gültige Adresse (URL) an.' };
      if (issue.validation === 'datetime' || issue.validation === 'date') {
        return { message: 'Bitte geben Sie ein gültiges Datum an.' };
      }
      if (issue.validation === 'time') return { message: 'Bitte geben Sie eine gültige Uhrzeit an.' };
      // Kennungen (cuid, uuid) und Muster: Die Person kann den Wert nicht
      // korrigieren, sondern nur neu wählen.
      return { message: 'Dieser Wert ist ungültig.' };

    case ZodIssueCode.invalid_enum_value:
    case ZodIssueCode.invalid_literal:
    case ZodIssueCode.invalid_union:
    case ZodIssueCode.invalid_union_discriminator:
      return { message: 'Bitte wählen Sie einen der angebotenen Werte.' };

    case ZodIssueCode.invalid_date:
      return { message: 'Bitte geben Sie ein gültiges Datum an.' };

    case ZodIssueCode.not_multiple_of:
      return { message: `Der Wert muss ein Vielfaches von ${issue.multipleOf} sein.` };

    case ZodIssueCode.not_finite:
      return { message: 'Bitte geben Sie eine endliche Zahl an.' };

    case ZodIssueCode.unrecognized_keys:
      return { message: 'Die Anfrage enthält unbekannte Felder.' };

    default:
      return { message: ctx.defaultError === 'Invalid input' ? 'Dieser Wert ist ungültig.' : ctx.defaultError };
  }
};

z.setErrorMap(deutscheFehlerkarte);
