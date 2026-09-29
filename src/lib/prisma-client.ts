/*
  `.env` laden wie Prisma 6 es tat (2026-09-29). Der Prisma-6-Client las die
  Datei beim Laden selbst; Skripte, Seeds und die Prüfhelfer verliessen sich
  darauf, ohne es zu wissen. Prisma 7 tut es nicht mehr — die erste volle
  Prüfreihe danach meldete 70-mal „kein Zugang zur Testdatenbank" und brach
  245 Fälle ab. `dotenv` überschreibt keine gesetzte Variable: Was der
  Prüfserver ausdrücklich setzt (Testdatenbank) und was Next selbst lädt,
  bleibt massgebend.
*/
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Der **einzige** Ort, an dem ein `PrismaClient` entsteht (seit Prisma 7,
 * 2026-09-29).
 *
 * Prisma 7 verbindet sich nicht mehr selbst: Die Rust-Abfragemaschine ist
 * weg, und der Konstruktor verlangt einen Treiberadapter. Die frühere Option
 * `datasources: { db: { url } }` — mit der Skripte, Seeds und die Prüfreihe
 * auf eine andere Datenbank zeigten — gibt es nicht mehr. Siebzehn Stellen
 * bauten ihren Client selbst; jede hätte den Adapter einzeln richtig setzen
 * müssen. Hier steht es einmal.
 *
 * **Adresse.** Ohne Angabe `DATABASE_URL`, wie der Client in Prisma 6 sie aus
 * dem Schema las. Wer eine andere Datenbank braucht (Testdatenbank,
 * Vorschaudatenbank, Wartungsverbindung, nur lesende Rolle), übergibt sie
 * ausdrücklich. Fehlt beides, bricht der Aufruf hier mit einer klaren Meldung
 * ab — statt beim ersten Zugriff mit einem Verbindungsfehler von `pg`.
 *
 * **Schema.** Die Verbindungsadressen tragen `?schema=public`. `pg` kennt den
 * Parameter nicht; der Adapter bekommt das Schema deshalb ausdrücklich, aus
 * der Adresse gelesen, damit eine Adresse mit anderem Schema weiter dorthin
 * zeigt.
 */
export function erzeugePrismaClient(
  optionen: {
    url?: string;
    log?: Prisma.PrismaClientOptions['log'];
    errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
  } = {},
): PrismaClient {
  const adresse = optionen.url ?? process.env.DATABASE_URL;
  if (!adresse) {
    throw new Error('Keine Datenbankadresse: DATABASE_URL ist nicht gesetzt.');
  }
  let schema: string | undefined;
  try {
    schema = new URL(adresse).searchParams.get('schema') ?? undefined;
  } catch {
    // Keine URL-Form (etwa ein Unix-Socket-Pfad) — `pg` wertet sie selbst aus.
  }
  /*
    **Sitzungszeitzone UTC — Pflicht, nicht Vorliebe** (2026-09-29).

    Der Adapter schreibt Zeitpunkte als UTC-Ziffern **ohne** Versatz
    (`formatDateTime`) und ersetzt beim Lesen jeden Versatz durch `+00:00`
    (`normalize_timestamptz`) — er setzt eine Sitzung in UTC voraus. Der
    Datenbankserver steht hier auf `Europe/Berlin`. Folge ohne diese Zeile,
    gemessen gegen die Testdatenbank: Postgres las „05:39" als Berliner Zeit
    und speicherte 03:39 UTC, zwei Stunden zu früh. In JavaScript sah der
    Rundlauf richtig aus, in der Datenbank nicht — und jeder Vergleich dort
    kippte: Der Trigger, der beim Sofortausstellen die Positionen einer eben
    angelegten Rechnung zulässt (`createdAt > now() - 10 min`), hielt jede
    solche Rechnung für alt und wies sie ab. Gegen Prisma-6-Daten wären alle
    Zeitpunkte beim Lesen um zwei Stunden verschoben gewesen.

    Verträglich mit dem rohen SQL der Anwendung: Tagesgrenzen stehen dort
    ausdrücklich mit `AT TIME ZONE 'Europe/Zurich'` oder hängen an `DATE`-
    Spalten, nirgends an der Sitzungszeitzone (durchgesehen 2026-09-29).
  */
  const adapter = new PrismaPg(
    { connectionString: adresse, options: '-c TimeZone=UTC' },
    schema ? { schema } : undefined,
  );
  return new PrismaClient({
    adapter,
    ...(optionen.log ? { log: optionen.log } : {}),
    ...(optionen.errorFormat ? { errorFormat: optionen.errorFormat } : {}),
  });
}
