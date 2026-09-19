/**
 * Altbestand an Dateien nachträglich prüfen und zuordnen.
 *
 * **Warum das nicht in der Migration steht.** Eine Migration läuft
 * unbeaufsichtigt und liest danach niemand mehr. Welche physische Zeile zu
 * welchem fachlichen Datensatz gehört, ist aber eine Entscheidung mit
 * Sicherheitsfolgen: Trifft sie daneben, hängt eine Datei am falschen
 * Geschäftsobjekt und damit an der falschen Berechtigung. Solche
 * Entscheidungen gehören in einen Aufruf, den jemand bewusst auslöst und
 * dessen Ausgabe jemand liest.
 *
 * **Standardmässig Trockenlauf.** Ohne `--schreiben` wird nichts verändert.
 *
 * Zwei Aufgaben:
 *
 *  1. **Prüfsumme nachtragen** für `StoredFile`-Zeilen mit Bytes, aber ohne
 *     `checksum`. Das ist gefahrlos: Der Hash wird über genau die Bytes
 *     gebildet, die dort liegen. Er sagt nichts darüber, ob die Datei je
 *     gegen ein Profil geprüft wurde — er hält nur fest, was heute da ist,
 *     damit eine spätere Veränderung auffällt.
 *
 *  2. **Beziehung nachtragen** zwischen `FileAsset` und `StoredFile`, wo die
 *     gespeicherte Adresse eindeutig auf genau eine Zeile zeigt. Mehrdeutig
 *     heisst: nicht zuordnen. Lieber eine Datei, die über die Ausgaberoute
 *     verschlossen bleibt, als eine, die am falschen Objekt hängt.
 *
 * Was dieses Skript **nicht** tut: Es setzt keine Sichtbarkeit. Ob eine alte
 * Datei öffentlich sein soll, lässt sich aus einem Pfad nicht ableiten, und
 * genau dieses Raten war der Fehler, den Gate 2 behebt.
 *
 *   npx tsx scripts/backfill-file-integrity.ts            # Trockenlauf
 *   npx tsx scripts/backfill-file-integrity.ts --schreiben
 */
import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const schreiben = process.argv.includes('--schreiben');

/** `/api/files/blob/<id>` — die Adressform der Rückfallebene. */
const BLOB = /\/api\/files\/blob\/([A-Za-z0-9_-]+)/;

async function pruefsummenNachtragen(): Promise<void> {
  const offen = await prisma.storedFile.findMany({
    where: { checksum: null, data: { not: null } },
    select: { id: true, path: true },
  });

  console.log(`\n1. Prüfsummen: ${offen.length} Zeile(n) mit Bytes, aber ohne Prüfsumme.`);

  for (const zeile of offen) {
    // Einzeln nachladen: Die Bytes können je Zeile 256 MB sein, und alle
    // zusammen in den Speicher zu ziehen bringt nichts ausser Risiko.
    const voll = await prisma.storedFile.findUnique({
      where: { id: zeile.id },
      select: { data: true },
    });
    if (!voll?.data) continue;

    const checksum = createHash('sha256').update(Buffer.from(voll.data)).digest('hex');
    console.log(`   ${schreiben ? '→' : '·'} ${zeile.path}  ${checksum.slice(0, 16)}…`);

    if (schreiben) {
      await prisma.storedFile.update({ where: { id: zeile.id }, data: { checksum } });
    }
  }
}

async function beziehungenNachtragen(): Promise<void> {
  const offen = await prisma.fileAsset.findMany({
    where: { storedFileId: null },
    select: { id: true, url: true, filename: true },
  });

  console.log(`\n2. Beziehungen: ${offen.length} Asset(s) ohne verknüpfte Ablage.`);

  let eindeutig = 0;
  let unklar = 0;

  for (const asset of offen) {
    const treffer = BLOB.exec(asset.url);
    if (!treffer) {
      unklar += 1;
      console.log(`   ? ${asset.filename} — Adresse zeigt nicht auf die Rückfallebene`);
      continue;
    }

    const kandidat = await prisma.storedFile.findUnique({
      where: { id: treffer[1] },
      select: { id: true, asset: { select: { id: true } } },
    });

    if (!kandidat) {
      unklar += 1;
      console.log(`   ? ${asset.filename} — die genannte Ablage gibt es nicht mehr`);
      continue;
    }

    if (kandidat.asset && kandidat.asset.id !== asset.id) {
      // Zwei Assets auf dieselbe Ablage: nicht raten, welches gilt.
      unklar += 1;
      console.log(`   ! ${asset.filename} — die Ablage gehört bereits einem anderen Asset`);
      continue;
    }

    eindeutig += 1;
    console.log(`   ${schreiben ? '→' : '·'} ${asset.filename} → ${kandidat.id}`);

    if (schreiben) {
      await prisma.fileAsset.update({
        where: { id: asset.id },
        data: { storedFileId: kandidat.id },
      });
    }
  }

  console.log(`   eindeutig: ${eindeutig} · nicht zugeordnet: ${unklar}`);
}

async function main(): Promise<void> {
  const name = process.env.DATABASE_URL?.split('/').pop()?.split('?')[0];
  console.log(`Datenbank: ${name}`);
  console.log(schreiben ? 'Modus: SCHREIBEN' : 'Modus: Trockenlauf (nichts wird verändert)');

  await pruefsummenNachtragen();
  await beziehungenNachtragen();

  if (!schreiben) {
    console.log('\nNichts verändert. Mit --schreiben ausführen, um die Änderungen zu übernehmen.');
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
