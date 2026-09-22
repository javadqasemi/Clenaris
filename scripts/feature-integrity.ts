import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Prüfung auf **halbe Merkmale**.
 *
 * ---------------------------------------------------------------------------
 *  Wogegen das gebaut ist
 * ---------------------------------------------------------------------------
 *
 * Dreimal ist in diesem Projekt dasselbe Muster aufgefallen, und jedes Mal
 * fiel es erst jemandem beim Durchklicken auf:
 *
 *   Ein Modell steht im Schema. Eine Berechtigung dafür steht im Katalog.
 *   Es gibt sogar eine Seite. **Nur schreibt niemand je eine Zeile.**
 *
 * So etwas besteht jede Prüfung, die es gibt: `tsc` ist zufrieden, die Tests
 * auch — sie prüfen, was da ist, nicht was fehlt —, und die Seite antwortet
 * mit 200. Sichtbar wird es erst, wenn jemand etwas anlegen will und die
 * Schaltfläche nicht findet.
 *
 * Dieses Skript sucht genau dieses Muster, und zwar **strukturell**: Es liest
 * Schema, Berechtigungskatalog, Dienste, Endpunkte und Oberfläche und fragt je
 * Modell, welche der fünf Schichten vorhanden sind.
 *
 * ---------------------------------------------------------------------------
 *  Was es ausdrücklich nicht ist
 * ---------------------------------------------------------------------------
 *
 * **Keine Wahrheit, sondern ein Hinweis.** Die Prüfung arbeitet mit
 * Zeichenkettensuche über den Quelltext — sie sieht `prisma.vertrag.create`,
 * versteht aber nicht, ob der Aufruf je erreicht wird. Sie wird Fälle melden,
 * die in Ordnung sind (ein Modell, das absichtlich nur vom Nachtlauf
 * geschrieben wird), und sie wird Fälle übersehen (ein Schreibpfad hinter
 * einer dynamisch gebauten Modellkennung).
 *
 * Deshalb **blockiert sie nichts**. Der Rückgabewert ist 0, auch wenn sie
 * etwas findet; die CI zeigt die Zusammenfassung an, mehr nicht. Eine
 * Heuristik, die einen Bau anhält, wird innerhalb einer Woche mit
 * Ausnahmelisten stillgelegt — dann hat man den Aufwand und die Meldung
 * verloren. `--streng` gibt es für den Fall, dass jemand sie bewusst als Tor
 * verwenden will.
 *
 * Aufruf: `npx tsx scripts/feature-integrity.ts [--streng]`
 */

const ROOT = process.cwd();
const SCHEMA = join(ROOT, 'prisma', 'schema.prisma');
const BERICHT = join(ROOT, 'artifacts', 'feature-integrity-report.json');

const streng = process.argv.includes('--streng');

// ---------------------------------------------------------------------------
//  Quellen einlesen
// ---------------------------------------------------------------------------

interface Quelldatei {
  pfad: string;
  inhalt: string;
}

function dateienUnter(verzeichnis: string, endungen: string[]): Quelldatei[] {
  const treffer: Quelldatei[] = [];
  const gehe = (ordner: string) => {
    let eintraege: string[];
    try {
      eintraege = readdirSync(ordner);
    } catch {
      return;
    }
    for (const eintrag of eintraege) {
      if (eintrag === 'node_modules' || eintrag.startsWith('.')) continue;
      const voll = join(ordner, eintrag);
      if (statSync(voll).isDirectory()) {
        gehe(voll);
        continue;
      }
      if (!endungen.some((e) => eintrag.endsWith(e))) continue;
      treffer.push({ pfad: relative(ROOT, voll).split(sep).join('/'), inhalt: readFileSync(voll, 'utf8') });
    }
  };
  gehe(verzeichnis);
  return treffer;
}

/**
 * Die Modellnamen aus dem Schema — ohne Prisma-Bibliothek.
 *
 * Ein Regex über `model X {` genügt und hält das Skript frei von einer
 * Abhängigkeit, die einen erzeugten Client braucht. Wer die Prüfung nach einer
 * Schemaänderung laufen lässt, soll nicht erst `prisma generate` brauchen.
 */
function modelle(schema: string): string[] {
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
}

/** Aus `ContractVersion` wird `contractVersion` — so heisst es am Prisma-Client. */
function klientName(modell: string): string {
  return modell.charAt(0).toLowerCase() + modell.slice(1);
}

/**
 * Wer schreibt dieses Modell **durch seinen Elternteil**?
 *
 * Der erste Entwurf dieser Prüfung meldete `InvoiceItem`, `JobPhoto` und
 * `Tag` als halbe Merkmale. Alle drei sind in Ordnung: Rechnungspositionen
 * entstehen in `invoice.create({ items: { create: […] } })`, Marken werden
 * über `connect` gesetzt. Es gibt schlicht kein `prisma.invoiceItem.create`,
 * und es soll auch keines geben — eine Position ohne ihren Beleg wäre ein
 * Datensatz ohne Bedeutung.
 *
 * Die Prüfung liest deshalb aus dem Schema, welches Modell als Beziehungsfeld
 * in welchem anderen steht, und zählt einen Schreibpfad des Elternteils mit,
 * wenn der Feldname im selben Dienst vorkommt. Ohne diese Regel wäre die
 * Meldung zu drei Vierteln Rauschen — und eine Meldung, die man gewohnheits-
 * mässig überliest, ist keine.
 */
function beziehungsEltern(schema: string): Map<string, { eltern: string; feld: string }[]> {
  const karte = new Map<string, { eltern: string; feld: string }[]>();
  const bloecke = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];

  for (const [, eltern, rumpf] of bloecke) {
    for (const zeile of rumpf!.split('\n')) {
      // `items       InvoiceItem[]` oder `contract  Contract  @relation(...)`
      const treffer = /^\s*(\w+)\s+(\w+)(\[\])?\s*(@relation|$|\s)/.exec(zeile);
      if (!treffer) continue;
      const [, feld, typ] = treffer;
      if (!typ || typ === eltern) continue;
      if (!/^[A-Z]/.test(typ)) continue;
      const bisher = karte.get(typ) ?? [];
      bisher.push({ eltern: eltern!, feld: feld! });
      karte.set(typ, bisher);
    }
  }
  return karte;
}

// ---------------------------------------------------------------------------
//  Die fünf Schichten je Modell
// ---------------------------------------------------------------------------

interface Befund {
  modell: string;
  schichten: {
    /** Schreibt irgendein Dienst dieses Modell? */
    schreibpfad: boolean;
    /** Oder entsteht es als verschachtelter Schreibvorgang an seinem Elternteil? */
    schreibpfadUeberEltern: string | null;
    /** Oder — entgegen der Architekturregel — unmittelbar im Endpunkt? */
    schreibpfadImEndpunkt: string[];
    /** Liest irgendetwas dieses Modell? */
    lesepfad: boolean;
    /** Gibt es eine Berechtigung, die danach benannt ist? */
    berechtigung: string | null;
    /** Nennt ein Endpunkt den Dienst, der es schreibt? */
    endpunkt: boolean;
    /** Kommt es in einer Seite oder Oberflächenkomponente vor? */
    oberflaeche: boolean;
  };
  /** Wo geschrieben wird — die ersten Fundstellen, zur Nachprüfung. */
  schreibstellen: string[];
  einstufung: 'vollstaendig' | 'halb' | 'dienstumgehung' | 'ohne_oberflaeche' | 'nur_daten';
  hinweis: string;
}

/**
 * Modelle, die absichtlich keinen Schreibpfad aus der Oberfläche haben.
 *
 * Jeder Eintrag trägt seinen Grund. Eine Ausnahmeliste ohne Begründungen wird
 * zur Mülltonne: Nach einem halben Jahr weiss niemand mehr, ob ein Name darin
 * steht, weil der Fall in Ordnung ist, oder weil jemand die Meldung loswerden
 * wollte.
 */
const BEGRUENDETE_AUSNAHMEN: Record<string, string> = {
  AuditLog: 'Nur anhängend, geschrieben vom Protokolldienst — eine Oberfläche zum Anlegen wäre ein Fehler.',
  SignatureEvent: 'Anhängend, mit Datenbanktrigger gegen Änderung und Löschung.',
  NumberSequence: 'Nummernkreis. Wird ausschliesslich in Belegtransaktionen fortgezählt.',
  KpiSnapshot: 'Entsteht im Nachtlauf; von Hand erfasste Kennzahlen wären keine Messung.',
  RefreshToken: 'Sitzungsverwaltung.',
  AccessToken: 'Zugangstoken, nur im Dienst.',
  Session: 'Sitzungsverwaltung.',
  WebhookEvent: 'Eingang von aussen.',
  EmailLog: 'Versandprotokoll.',
  SmsLog: 'Versandprotokoll.',
};

function untersuche(modell: string, quellen: {
  dienste: Quelldatei[];
  routen: Quelldatei[];
  seiten: Quelldatei[];
  berechtigungen: string;
  eltern: Map<string, { eltern: string; feld: string }[]>;
}): Befund {
  const klient = klientName(modell);

  /*
    Sowohl `prisma.x.create` als auch `tx.x.create` — Schreibvorgänge in einer
    Transaktion laufen über den Transaktionsklienten, und genau die sind die
    interessanten.
  */
  const schreibMuster = new RegExp(
    `\\b(?:prisma|tx|client|db)\\.${klient}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`,
  );
  const leseMuster = new RegExp(`\\b(?:prisma|tx|client|db)\\.${klient}\\.(find|count|aggregate|groupBy)`);

  const schreibstellen = quellen.dienste
    .filter((d) => schreibMuster.test(d.inhalt))
    .map((d) => d.pfad)
    .slice(0, 5);

  const lesepfad =
    quellen.dienste.some((d) => leseMuster.test(d.inhalt)) ||
    quellen.seiten.some((d) => leseMuster.test(d.inhalt)) ||
    quellen.routen.some((d) => leseMuster.test(d.inhalt));

  /*
    Die Berechtigung heisst nach der Ressource, nicht nach dem Modell:
    `contract:create` zu `Contract`, `quote:send` zu `Quote`. Verglichen wird
    deshalb der kleingeschriebene Modellname gegen den Teil vor dem Doppelpunkt.
  */
  const ressource = klient;
  const berechtigungsTreffer = new RegExp(`'${ressource}:([a-z_]+)'`).exec(quellen.berechtigungen);

  const endpunkt =
    quellen.routen.some((d) => schreibMuster.test(d.inhalt)) ||
    quellen.routen.some((d) => new RegExp(`\\b${ressource}\\.service\\b`).test(d.inhalt));

  const oberflaeche = quellen.seiten.some(
    (d) => d.inhalt.includes(`${modell}`) || d.inhalt.includes(`/${ressource}`),
  );

  /*
    Der verschachtelte Schreibvorgang: Der Elternteil wird geschrieben, und im
    selben Dienst kommt der Feldname vor, unter dem dieses Modell dort hängt.
  */
  let ueberEltern: string | null = null;
  for (const { eltern, feld } of quellen.eltern.get(modell) ?? []) {
    const elternMuster = new RegExp(
      `\\b(?:prisma|tx|client|db)\\.${klientName(eltern)}\\.(create|update|upsert)\\b`,
    );
    const feldMuster = new RegExp(`\\b${feld}\\s*:\\s*\\{`);
    const treffer = quellen.dienste.find((d) => elternMuster.test(d.inhalt) && feldMuster.test(d.inhalt));
    if (treffer) {
      ueberEltern = `${eltern}.${feld} (${treffer.pfad})`;
      break;
    }
  }

  /*
    Schreibt ein **Endpunkt** unmittelbar in die Datenbank, statt einen Dienst
    zu rufen? Das ist keine halbe Funktion, sondern eine andere Abweichung —
    und eine, die genau so aussieht wie eine vollständige, solange man nur die
    Oberfläche prüft. Gefunden wurde sie hier zuerst bei `Expense`, `Supplier`
    und `Message`.

    Warum das zählt: Berechtigungsprüfung, Validierung und Protokoll leben in
    der Endpunktfabrik, die Geschäftsregeln im Dienst. Wer die zweite Hälfte
    überspringt, hat die Regel dort, wo der nächste Aufrufer sie nicht findet
    — und der nächste Aufrufer ist der Nachtlauf oder ein Skript.
  */
  const schreibpfadImEndpunkt = quellen.routen
    .filter((r) => schreibMuster.test(r.inhalt))
    .map((r) => r.pfad);

  const schichten = {
    schreibpfad: schreibstellen.length > 0,
    schreibpfadUeberEltern: ueberEltern,
    schreibpfadImEndpunkt,
    lesepfad,
    berechtigung: berechtigungsTreffer ? `${ressource}:${berechtigungsTreffer[1]}` : null,
    endpunkt,
    oberflaeche,
  };

  let einstufung: Befund['einstufung'] = 'vollstaendig';
  let hinweis = '';

  const geschrieben = schichten.schreibpfad || schichten.schreibpfadUeberEltern !== null;

  if (BEGRUENDETE_AUSNAHMEN[modell]) {
    einstufung = 'nur_daten';
    hinweis = BEGRUENDETE_AUSNAHMEN[modell]!;
  } else if (!geschrieben && schreibpfadImEndpunkt.length > 0) {
    einstufung = 'dienstumgehung';
    hinweis = `Geschrieben unmittelbar im Endpunkt (${schreibpfadImEndpunkt.join(', ')}), nicht über einen Dienst in src/server/services.`;
  } else if (!geschrieben && (schichten.berechtigung || schichten.oberflaeche)) {
    /*
      Das gesuchte Muster: Es gibt eine Berechtigung oder eine Seite — also
      hat jemand das Merkmal geplant —, aber keine Stelle, die je schreibt.
    */
    einstufung = 'halb';
    hinweis = schichten.berechtigung
      ? `Berechtigung „${schichten.berechtigung}" vorhanden, aber kein Dienst schreibt dieses Modell.`
      : 'In der Oberfläche erwähnt, aber kein Dienst schreibt dieses Modell.';
  } else if (!geschrieben) {
    einstufung = 'nur_daten';
    hinweis = 'Kein Schreibpfad — vermutlich abgeleitet oder noch nicht in Gebrauch.';
  } else if (!schichten.oberflaeche) {
    einstufung = 'ohne_oberflaeche';
    hinweis = 'Schreibpfad vorhanden, aber nichts in der Oberfläche verweist darauf.';
  }

  return { modell, schichten, schreibstellen, einstufung, hinweis };
}

// ---------------------------------------------------------------------------
//  Endpunkte ohne Oberfläche
// ---------------------------------------------------------------------------

/**
 * Der zweite Befund aus der Prüfung vom 13.09.2026: über ein Dutzend
 * schreibende Endpunkte, die keine Schaltfläche je aufruft.
 *
 * Gesucht wird der Pfad in den Seiten- und Oberflächenkomponenten, und zwar
 * als **Muster**, nicht als Zeichenkette: Im Quelltext steht keine feste
 * Adresse, sondern eine Vorlage —
 * `` `/api/contracts/${vertrag.id}/amendments/${antrag.id}/decision` ``. Aus
 * `[id]` wird deshalb `\$\{…\}`.
 *
 * **Bekannte Lücke, bewusst offen gelassen.** Wer die Adresse selbst
 * zusammensetzt — `` `/api/time/${richtung === 'in' ? 'clock-in' : …}` `` —
 * wird als „ohne Aufruf" gemeldet, obwohl der Aufruf existiert. Das liesse
 * sich nur mit einer Auswertung des Programms statt des Textes lösen. Für
 * eine Prüfung, die nichts blockiert und bei der jemand die Liste durchsieht,
 * ist der Falschbefund billiger als die Auswertung.
 */
function endpunkteOhneAufruf(routen: Quelldatei[], seiten: Quelldatei[]): string[] {
  const ohne: string[] = [];

  for (const route of routen) {
    if (!/export const (POST|PATCH|PUT|DELETE)\b/.test(route.inhalt)) continue;
    // `src/app/api/contracts/[id]/activate/route.ts` → `/api/contracts/[id]/activate`
    const pfad = route.pfad.replace(/^src\/app/, '').replace(/\/route\.ts$/, '');
    if (pfad.startsWith('/api/cron') || pfad.startsWith('/api/webhooks')) continue;
    if (pfad.startsWith('/api/public') || pfad.startsWith('/api/auth')) continue;

    const muster = new RegExp(
      pfad
        .split('/')
        .map((teil) =>
          teil.startsWith('[') ? '\\$\\{[^}]*\\}' : teil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/'),
    );

    if (!seiten.some((s) => muster.test(s.inhalt))) ohne.push(pfad);
  }

  return ohne.sort();
}

// ---------------------------------------------------------------------------
//  Lauf
// ---------------------------------------------------------------------------

function main(): void {
  const schema = readFileSync(SCHEMA, 'utf8');
  const dienste = dateienUnter(join(ROOT, 'src', 'server'), ['.ts']);
  const routen = dateienUnter(join(ROOT, 'src', 'app', 'api'), ['.ts']);
  const seiten = [
    ...dateienUnter(join(ROOT, 'src', 'app'), ['.tsx']),
    ...dateienUnter(join(ROOT, 'src', 'features'), ['.tsx', '.ts']),
    ...dateienUnter(join(ROOT, 'src', 'components'), ['.tsx']),
  ];
  const berechtigungen = readFileSync(join(ROOT, 'src', 'lib', 'auth', 'permissions.ts'), 'utf8');

  const eltern = beziehungsEltern(schema);
  const befunde = modelle(schema).map((modell) =>
    untersuche(modell, { dienste, routen, seiten, berechtigungen, eltern }),
  );

  const halbe = befunde.filter((b) => b.einstufung === 'halb');
  const dienstumgehungen = befunde.filter((b) => b.einstufung === 'dienstumgehung');
  const ohneOberflaeche = befunde.filter((b) => b.einstufung === 'ohne_oberflaeche');
  const verwaisteEndpunkte = endpunkteOhneAufruf(routen, seiten);

  const bericht = {
    erzeugtAm: new Date().toISOString(),
    hinweis:
      'Heuristik über den Quelltext, keine Wahrheit. Findet das Muster „Schema + Berechtigung + Oberfläche, aber kein Schreibpfad". Blockiert nichts.',
    zusammenfassung: {
      modelle: befunde.length,
      halbeMerkmale: halbe.length,
      dienstumgehungen: dienstumgehungen.length,
      ohneOberflaeche: ohneOberflaeche.length,
      endpunkteOhneAufruf: verwaisteEndpunkte.length,
    },
    halbeMerkmale: halbe,
    dienstumgehungen,
    ohneOberflaeche: ohneOberflaeche.map((b) => ({ modell: b.modell, hinweis: b.hinweis })),
    endpunkteOhneAufruf: verwaisteEndpunkte,
    alleModelle: befunde,
  };

  mkdirSync(join(ROOT, 'artifacts'), { recursive: true });
  writeFileSync(BERICHT, `${JSON.stringify(bericht, null, 2)}\n`, 'utf8');

  // --- Zusammenfassung für die CI ------------------------------------------
  console.log('Merkmalsprüfung — halbe Merkmale, Endpunkte ohne Aufruf\n');
  console.log(`  Modelle im Schema:        ${befunde.length}`);
  console.log(`  Halbe Merkmale:           ${halbe.length}`);
  console.log(`  Dienstumgehungen:         ${dienstumgehungen.length}`);
  console.log(`  Ohne Oberfläche:          ${ohneOberflaeche.length}`);
  console.log(`  Endpunkte ohne Aufruf:    ${verwaisteEndpunkte.length}\n`);

  if (halbe.length > 0) {
    console.log('  Halbe Merkmale — geplant, aber ohne Schreibpfad:');
    for (const b of halbe) console.log(`    · ${b.modell} — ${b.hinweis}`);
    console.log('');
  }
  if (dienstumgehungen.length > 0) {
    console.log('  Im Endpunkt geschrieben statt im Dienst:');
    for (const b of dienstumgehungen) {
      console.log(`    · ${b.modell} — ${b.schichten.schreibpfadImEndpunkt.join(', ')}`);
    }
    console.log('');
  }
  if (verwaisteEndpunkte.length > 0) {
    console.log('  Schreibende Endpunkte, die keine Oberfläche aufruft:');
    for (const p of verwaisteEndpunkte.slice(0, 25)) console.log(`    · ${p}`);
    if (verwaisteEndpunkte.length > 25) console.log(`    … und ${verwaisteEndpunkte.length - 25} weitere`);
    console.log('');
  }

  console.log(`  Bericht: ${relative(ROOT, BERICHT).split(sep).join('/')}`);

  if (streng && (halbe.length > 0 || verwaisteEndpunkte.length > 0)) {
    console.error('\n  --streng: Befunde vorhanden.');
    process.exit(1);
  }
}

main();
