import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { testCacheDir } from './rate-limit';

/**
 * Der Postausgang des Testservers — lesend.
 *
 * Der Testserver schreibt jede simulierte E-Mail als Datei nach
 * `<CLENARIS_TEST_CACHE_DIR>/mail/` (`src/lib/email/client.ts`). Das ist der
 * einzige Weg, an einen *tatsächlich versendeten* Link zu kommen: Der rohe
 * Token steht nur in der Nachricht, in der Datenbank liegt sein Hash.
 *
 * Ohne Postausgang (Server ohne die Variable) liefern die Helfer `null`,
 * und die betroffenen Prüfungen überspringen sich — sie könnten sonst nur
 * einen selbst gebauten Token fahren, und genau das sollen sie nicht.
 */

export interface TestMail {
  at: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  templateKey: string | null;
  entity: string | null;
  entityId: string | null;
  attachments: string[];
  datei: string;
}

function ordner(): string {
  return join(testCacheDir(), 'mail');
}

export function mailOutboxAvailable(): boolean {
  return existsSync(testCacheDir());
}

export function alleMails(): TestMail[] {
  const dir = ordner();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      try {
        return { ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as Omit<TestMail, 'datei'>), datei: f };
      } catch {
        return null;
      }
    })
    .filter((m): m is TestMail => m !== null);
}

/** Die jüngste Nachricht, die den Filter erfüllt. */
export function letzteMail(filter: { to?: string; templateKey?: string; entityId?: string; subjectEnthaelt?: string }): TestMail | null {
  const treffer = alleMails().filter(
    (m) =>
      (!filter.to || m.to.some((t) => t.toLowerCase() === filter.to!.toLowerCase())) &&
      (!filter.templateKey || m.templateKey === filter.templateKey) &&
      (!filter.entityId || m.entityId === filter.entityId) &&
      (!filter.subjectEnthaelt || m.subject.includes(filter.subjectEnthaelt)),
  );
  return treffer.at(-1) ?? null;
}

/** Alle Links einer Nachricht — aus dem HTML, in Reihenfolge. */
export function linksIn(mail: TestMail): string[] {
  const out: string[] = [];
  for (const m of mail.html.matchAll(/href="([^"]+)"/g)) out.push(m[1]!.replace(/&amp;/g, '&'));
  return out;
}

export function postausgangLeeren(): void {
  const dir = ordner();
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
}
