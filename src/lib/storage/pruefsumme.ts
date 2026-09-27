import { createHash } from 'node:crypto';

/**
 * Die Prüfsummenentscheidung beim **Lesen** — rein, ohne Speicher und ohne
 * Datenbank (F-09 c, 2026-09-27).
 *
 * **Warum ein eigenes Modul ohne `server-only`.** Dieselbe Überlegung wie bei
 * `lib/security/malware/auslieferung.ts`: Die Regel entscheidet, ob Bytes
 * hinausgehen, und eine Regel dieser Tragweite soll sich ohne laufenden Server
 * prüfen lassen. Über HTTP liesse sich nur beobachten, *dass* nichts kommt —
 * nicht, ob eine fehlende Datei, veränderte Bytes und widersprüchliche
 * Datensätze aus drei verschiedenen Gründen abgewiesen werden oder aus
 * Versehen alle aus demselben. `tests/api/ablage-vertrag.test.ts` prüft sie
 * direkt.
 *
 * **Warum beim Lesen und nicht nur beim Prüflauf.** `scanFileAsset` hält die
 * Bytes einmal gegen die Prüfsumme, bevor der Prüfer sie sieht. Ausgeliefert
 * wird aber später und beliebig oft — und beim externen Speicher liegen die
 * Bytes in einem Dienst, auf den ausser dieser Anwendung auch jede Person mit
 * dem Dienstschlüssel oder Zugang zur Supabase-Oberfläche schreiben kann. Ein
 * Befund über Bytes, die nicht mehr die ausgelieferten sind, ist wertlos; die
 * Gegenprobe gehört deshalb an die Stelle, an der die Bytes das Haus verlassen.
 */

export type LesePruefung =
  /** Bytes stimmen mit jeder vorhandenen Prüfsumme überein. */
  | { status: 'ok'; checksum: string }
  /**
   * Es gibt keine Prüfsumme, gegen die sich halten liesse — Altbestand aus der
   * Zeit vor Gate 2. Ausgeliefert wird trotzdem, weil über solche Dateien
   * bereits `darfAusgeliefertWerden` entschieden hat (Altbestand nur mit
   * `CLENARIS_LEGACY_FILES=allow`). Der eigene Status hält fest, dass hier
   * **keine** Zusicherung gegeben wurde — `ungeprueft` ist nicht `ok`.
   */
  | { status: 'ungeprueft'; checksum: string }
  /**
   * Die gelesenen Bytes weichen von der physischen Prüfsumme ab: Die Ablage
   * wurde nach dem Abschluss verändert. Der schwere Fall.
   */
  | { status: 'abweichung'; erwartet: string; tatsaechlich: string }
  /**
   * Die beiden Datensätze — Ablagezeile und `FileAsset` — nennen
   * verschiedene Prüfsummen. Welche stimmt, lässt sich nicht entscheiden;
   * ausgeliefert wird keine der beiden Fassungen. Dieselbe Linie wie
   * `lohnPdfLesen` in `payroll.service.ts`.
   */
  | { status: 'widerspruch'; ablage: string; asset: string };

export function sha256HexVon(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Stimmen die gelesenen Bytes mit dem überein, was beim Ablegen festgehalten
 * wurde?
 *
 * `ablage` ist `StoredFile.checksum` (die physische Prüfsumme), `asset` die
 * Momentaufnahme am `FileAsset`. Die Reihenfolge der Prüfungen ist Absicht:
 * Erst die Bytes gegen die physische Prüfsumme — weichen sie ab, ist die
 * Ablage verändert, gleich was der zweite Datensatz sagt. Erst danach der
 * Abgleich der Datensätze untereinander.
 *
 * Verglichen wird in Kleinschrift: Beide Felder schreibt die Anwendung selbst
 * als Kleinschrift-Hex, aber eine Grossschrift aus einem Import soll nicht als
 * „verändert" gelten und eine Quarantäne auslösen.
 */
export function pruefeGeleseneBytes(
  bytes: Uint8Array,
  soll: { ablage: string | null; asset?: string | null },
): LesePruefung {
  const tatsaechlich = sha256HexVon(bytes);
  const ablage = soll.ablage?.trim().toLowerCase() || null;
  const asset = soll.asset?.trim().toLowerCase() || null;

  const physisch = ablage ?? asset;
  if (!physisch) return { status: 'ungeprueft', checksum: tatsaechlich };

  if (tatsaechlich !== physisch) return { status: 'abweichung', erwartet: physisch, tatsaechlich };

  if (ablage && asset && ablage !== asset) return { status: 'widerspruch', ablage, asset };

  return { status: 'ok', checksum: tatsaechlich };
}
