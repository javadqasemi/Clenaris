/**
 * Umfangszahlen der Anwendung — gezählt, nicht abgeschrieben (2026-09-27).
 *
 *   npx tsx scripts/kennzahlen.ts          # README.md nachführen
 *   npx tsx scripts/kennzahlen.ts --pruefen # nur prüfen, Exit 1 bei Abweichung
 *
 * Die README nannte 134 Seiten, 374 Endpunkte und 111 Modelle, als das System
 * längst 166, 538 und 151 hatte. Von Hand gepflegte Zahlen veralten mit dem
 * ersten Commit danach und lesen sich dann wie eine Aussage über den heutigen
 * Stand. Deshalb stehen sie in der README nur noch zwischen
 * `<!-- kennzahlen:… -->`-Markern, und dieses Skript schreibt sie — als Teil
 * von `npm run docs`. Die CI prüft danach, dass `docs/` und README
 * unverändert sind; eine vergessene Zahl scheitert dort.
 *
 * Gezählt wird, was sich eindeutig zählen lässt: Seiten (`page.tsx`),
 * Route-Dateien, Operationen (aus der erzeugten OpenAPI-Beschreibung — sie
 * ist gegen den Routenbaum geprüft), Modelle und Aufzählungstypen im Schema,
 * Migrationen, Dienste, Prüfdateien. Keine Zeilenzahl: Sie ändert sich mit
 * jedem Commit und sagt nichts.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WURZEL = resolve(__dirname, '..');

function dateien(verzeichnis: string, passt: (name: string) => boolean): string[] {
  const treffer: string[] = [];
  for (const eintrag of readdirSync(verzeichnis)) {
    const pfad = join(verzeichnis, eintrag);
    if (statSync(pfad).isDirectory()) treffer.push(...dateien(pfad, passt));
    else if (passt(eintrag)) treffer.push(pfad);
  }
  return treffer;
}

export function zaehlen() {
  const schema = readFileSync(join(WURZEL, 'prisma', 'schema.prisma'), 'utf8');
  const openapi = JSON.parse(readFileSync(join(WURZEL, 'docs', 'openapi.json'), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const METHODEN = new Set(['get', 'post', 'put', 'patch', 'delete']);
  return {
    seiten: dateien(join(WURZEL, 'src', 'app'), (n) => n === 'page.tsx').length,
    routenDateien: dateien(join(WURZEL, 'src', 'app', 'api'), (n) => n === 'route.ts').length,
    operationen: Object.values(openapi.paths).reduce((s, p) => s + Object.keys(p).filter((m) => METHODEN.has(m)).length, 0),
    modelle: (schema.match(/^model \w+ \{/gm) ?? []).length,
    aufzaehlungen: (schema.match(/^enum \w+ \{/gm) ?? []).length,
    migrationen: readdirSync(join(WURZEL, 'prisma', 'migrations')).filter((n) => statSync(join(WURZEL, 'prisma', 'migrations', n)).isDirectory()).length,
    dienste: dateien(join(WURZEL, 'src', 'server', 'services'), (n) => n.endsWith('.service.ts')).length,
    pruefdateien: dateien(join(WURZEL, 'tests'), (n) => n.endsWith('.test.ts') || n.endsWith('.spec.ts')).length,
  };
}

function ersetzen(text: string, marke: string, inhalt: string): string {
  const muster = new RegExp(`(<!-- kennzahlen:${marke} -->)[\\s\\S]*?(<!-- /kennzahlen:${marke} -->)`);
  if (!muster.test(text)) throw new Error(`Marker kennzahlen:${marke} fehlt in README.md.`);
  return text.replace(muster, `$1${inhalt}$2`);
}

function main(): void {
  const z = zaehlen();
  const pfad = join(WURZEL, 'README.md');
  const vorher = readFileSync(pfad, 'utf8');
  let nachher = vorher;
  nachher = ersetzen(
    nachher,
    'umfang',
    `${z.seiten} Seiten · ${z.routenDateien} Route-Dateien mit ${z.operationen} Endpunkten · ${z.modelle} Datenmodelle · ${z.dienste} Dienste · ${z.pruefdateien} Prüfdateien`,
  );
  nachher = ersetzen(nachher, 'schema', `${z.modelle} Modelle, ${z.aufzaehlungen} Aufzählungstypen`);
  nachher = ersetzen(nachher, 'migrationen', `${z.migrationen} Migrationen`);
  nachher = ersetzen(nachher, 'api', `${z.routenDateien} Route-Dateien, ${z.operationen} Endpunkte`);
  nachher = ersetzen(nachher, 'api-doku', `alle ${z.operationen} Endpunkte`);

  if (process.argv.includes('--pruefen')) {
    if (nachher !== vorher) {
      console.error('❌  README.md nennt andere Zahlen als der Code — `npx tsx scripts/kennzahlen.ts` ausführen.');
      process.exit(1);
    }
    console.log('✓ README-Kennzahlen stimmen.');
    return;
  }
  if (nachher !== vorher) writeFileSync(pfad, nachher, 'utf8');
  console.log(`✓ README.md: ${z.seiten} Seiten, ${z.operationen} Endpunkte, ${z.modelle} Modelle, ${z.migrationen} Migrationen.`);
}

if (require.main === module) main();
