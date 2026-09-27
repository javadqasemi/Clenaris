import { PrismaClient, type UserRole } from '@prisma/client';
import { hash } from '@node-rs/argon2';

import { istOeffentlichesPasswort } from '../src/lib/auth/oeffentliche-zugangsdaten';

/**
 * Legt ein Verwaltungskonto an oder setzt es zurück.
 *
 *   npx tsx scripts/create-admin.ts <E-Mail> <Passwort> [Rolle] [Vorname] [Nachname]
 *
 * Rolle: SUPER_ADMIN (Standard) oder ADMIN. Existiert die E-Mail bereits,
 * werden Passwort, Rolle und Status überschrieben und Sperre, Fehlversuche
 * und Papierkorb zurückgesetzt — dieselbe Reparaturlogik wie im Seed, damit
 * ein ausgesperrtes Konto mit einem Aufruf wieder nutzbar ist.
 *
 * Direkt über Prisma statt über `POST /api/employees`: Der Endpunkt legt
 * Personal mit Einladung an und vergibt keine SUPER_ADMIN-Rolle — dafür
 * braucht es `role:assign`, das nur ein bestehendes SUPER_ADMIN-Konto hat.
 * Ein erstes solches Konto muss von aussen kommen.
 */

// Dieselben Argon2-Parameter wie im Seed und im Anmeldedienst.
const ARGON_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

const prisma = new PrismaClient();

async function main() {
  const [email, password, roleArg = 'SUPER_ADMIN', firstName = 'Admin', lastName = 'Konto'] =
    process.argv.slice(2);

  if (!email || !password) {
    console.error('Aufruf: npx tsx scripts/create-admin.ts <E-Mail> <Passwort> [SUPER_ADMIN|ADMIN] [Vorname] [Nachname]');
    process.exit(1);
  }
  if (roleArg !== 'SUPER_ADMIN' && roleArg !== 'ADMIN') {
    console.error(`Unbekannte Rolle „${roleArg}" — erlaubt sind SUPER_ADMIN und ADMIN.`);
    process.exit(1);
  }
  if (password.length < 10) {
    console.error('Das Passwort muss mindestens 10 Zeichen haben.');
    process.exit(1);
  }
  /**
   * Veröffentlichte Passwörter nie — auch nicht in der Entwicklung
   * (Notfallauftrag 2026-09-27). Dieses Skript ist genau der Weg, auf dem das
   * erste Verwaltungskonto eines neuen Systems entsteht; es ist der letzte
   * Ort, an dem ein Passwort aus dem Repository landen darf. Anders als
   * Anmeldung und Seed kennt es deshalb keine Ausnahme für Wegwerf-Systeme:
   * Wer dort ein Verwaltungskonto braucht, hat den Seed.
   */
  if (istOeffentlichesPasswort(password)) {
    console.error('Dieses Passwort ist öffentlich bekannt (es stand im Repository) und wird nicht gesetzt. Erzeugen: openssl rand -base64 24');
    process.exit(1);
  }
  const role: UserRole = roleArg;

  // Über den Slug wie `getOrganizationId()` — ein Konto in „der ersten" Organisation
  // landete bei mehr als einer Organisation womöglich in der falschen.
  const org = await prisma.organization.findUniqueOrThrow({ where: { slug: process.env.ORGANIZATION_SLUG ?? 'clenaris' } });
  const passwordHash = await hash(password, ARGON_OPTIONS);

  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      passwordHash,
      role,
      status: 'ACTIVE',
      deletedAt: null,
      lockedUntil: null,
      failedLoginCount: 0,
      mustChangePassword: false,
      emailVerified: new Date(),
    },
    create: {
      organizationId: org.id,
      email: email.toLowerCase(),
      passwordHash,
      firstName,
      lastName,
      role,
      status: 'ACTIVE',
      emailVerified: new Date(),
      locale: 'DE',
    },
  });

  console.log(`✓ ${user.email} — Rolle ${user.role}, Status ${user.status}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
