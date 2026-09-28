import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Tagesgebundener Sitzungshash der Besuchsmessung (2026-09-28).
 *
 * ---------------------------------------------------------------------------
 *  Was das Problem ist
 * ---------------------------------------------------------------------------
 *
 * Um „Sitzungen" zählen zu können, braucht jedes Ereignis ein Merkmal, das
 * die Ereignisse eines Besuchs zusammenhält. Der Browser erzeugt dafür je Tab
 * eine Zufallskennung (`sessionStorage`, stirbt mit dem Tab). Diese Kennung
 * roh zu speichern hiesse aber, eine Spalte zu haben, über die sich alles
 * verbinden lässt, was dieselbe Kennung je gesendet hat — und ein Tab kann
 * tagelang offen bleiben.
 *
 * ---------------------------------------------------------------------------
 *  Was hier geschieht
 * ---------------------------------------------------------------------------
 *
 * Gespeichert wird `HMAC-SHA256(tagesschluessel, kennung)`. Der
 * Tagesschlüssel wird per HKDF aus dem Servergeheimnis und dem **Zürcher
 * Kalendertag** abgeleitet. Folgen:
 *
 *  • Innerhalb eines Tages ergibt dieselbe Kennung denselben Hash — die
 *    Sitzung lässt sich zählen.
 *  • Am nächsten Tag ergibt sie einen anderen — zwei Tage lassen sich über
 *    die Tabelle nicht verknüpfen, auch nicht von jemandem, der die ganze
 *    Tabelle besitzt.
 *  • Ohne das Servergeheimnis lässt sich aus einer bekannten Kennung der Hash
 *    nicht nachrechnen; eine rohe Kennung liegt ohnehin nirgends.
 *
 * **Verworfene Alternative: ein zufälliges Tagessalz, das um Mitternacht
 * gelöscht wird.** Das wäre die stärkere Aussage (selbst mit dem Geheimnis
 * liessen sich vergangene Tage nicht nachrechnen), braucht aber einen
 * gemeinsamen, beschreibbaren Speicher, den jeder Serverprozess zur selben
 * Zeit gleich sieht — ohne Redis ist das die Datenbank, und dann liegt das
 * Salz neben den Hashes. Die Ableitung kommt ohne gemeinsamen Zustand aus.
 * Die Restgrenze steht offen in `docs/TRAFFIC_ANALYTICS.md`: Wer das
 * Servergeheimnis **und** eine rohe Kennung hat, kann deren Hash für jeden Tag
 * bilden. Eine rohe Kennung gibt es aber nur im Tab der Besucherin.
 *
 * Nebenwirkung, die bewusst in Kauf genommen wird: Eine Sitzung über
 * Mitternacht zählt als zwei.
 *
 * Ohne `server-only`, damit die Prüfreihe die Eigenschaften direkt belegen
 * kann; im Browser wird diese Datei nie importiert (`node:crypto`).
 */
export function sitzungsHash(kennung: string, tag: string, geheimnis: string): string {
  if (!geheimnis) throw new Error('Ohne Servergeheimnis lässt sich kein Sitzungshash bilden.');
  const schluessel = Buffer.from(
    hkdfSync('sha256', geheimnis, 'clenaris-besuchsmessung', `sitzung:${tag}`, 32),
  );
  return createHmac('sha256', schluessel).update(kennung).digest('hex');
}
