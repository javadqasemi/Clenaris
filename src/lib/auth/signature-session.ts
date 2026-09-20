import 'server-only';

import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';

import { randomToken } from '@/lib/auth/jwt';
import { deriveSecret, sha256Hex } from '@/lib/crypto';

/**
 * Die Sitzung einer unterzeichnenden Person — zustandslos, kurz, eng.
 *
 * **Warum es sie gibt.** Der Signaturlink trägt den rohen Capability-Token.
 * Würde er den ganzen Ablauf hindurch in der Adresse stehen, stünde er in
 * Browserverlauf, Bildschirmfotos, Referrer jedes PDF-Abrufs und in jedem
 * Zugriffsprotokoll eines Proxys. Deshalb wird er genau einmal getauscht —
 * gegen dieses Cookie — und verschwindet danach aus allem, was der Browser
 * anfragt.
 *
 * **Warum kein Datenbankmodell.** Alles, was die Sitzung beweisen muss, steht
 * in der Datenbank ohnehin: Vorgang, Teilnehmer, der Token, aus dem sie
 * hervorging. Das Cookie sagt nur, *welche* Zeilen zu prüfen sind, und ist
 * signiert, damit das niemand fälscht. Widerruf braucht keine Sitzungstabelle:
 * Jede Route prüft, ob der Token (`tok`) noch gilt — abgebrochen heisst
 * widerrufen, widerrufen heisst Sitzung wertlos.
 *
 * **Was drinsteht — und was nicht.** Kennungen (`req`, `part`, `tok`, `jti`).
 * Kein roher Token, kein Code, keine E-Mail, kein Name, keine Unterschrift.
 * Der Pfad ist auf die Signatur-API beschränkt; die Seiten selbst brauchen das
 * Cookie nicht, sie holen ihren Zustand über die API.
 *
 * Eigener Schlüssel (HKDF, Kontext `clenaris-signature-session-v1`): Selbst
 * wenn irgendwo die `typ`-Prüfung fehlte, verifizierte ein Signatur-Cookie
 * nie als Anmeldesitzung.
 */

export const SIGNATURE_COOKIE = 'clenaris_sig';
export const SIGNATURE_COOKIE_PATH = '/api/public/signatures';
/** Fest, kein Gleiten: Ein Unterzeichnungsvorgang ist kurz. */
export const SIGNATURE_SESSION_TTL_S = 60 * 60;

/** Wofür die Sitzung gilt: unterzeichnen oder nur das Ergebnis ansehen. */
export type SignatureSessionScope = 'sign' | 'result';

export interface SignatureSessionClaims {
  typ: 'sig';
  scope: SignatureSessionScope;
  jti: string;
  req: string;
  part: string;
  tok: string;
}

let cachedKey: Uint8Array | null = null;
function key(): Uint8Array {
  cachedKey ??= new Uint8Array(deriveSecret('clenaris-signature-session-v1'));
  return cachedKey;
}

export async function issueSignatureSession(params: {
  scope: SignatureSessionScope;
  requestId: string;
  participantId: string;
  tokenId: string;
}): Promise<{ token: string; jti: string; expiresAt: Date }> {
  // Jede Ausstellung ein neues, zufälliges `jti` — keine ableitbare Kennung.
  const jti = randomToken(16);
  const expiresAt = new Date(Date.now() + SIGNATURE_SESSION_TTL_S * 1000);
  const token = await new SignJWT({
    typ: 'sig',
    scope: params.scope,
    req: params.requestId,
    part: params.participantId,
    tok: params.tokenId,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
  return { token, jti, expiresAt };
}

export function signatureCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: SIGNATURE_COOKIE_PATH,
    maxAge: SIGNATURE_SESSION_TTL_S,
  };
}

/** Die Sitzung aus dem Cookie lesen — oder `null`, wenn keine gültige vorliegt. */
export async function readSignatureSession(): Promise<SignatureSessionClaims | null> {
  const store = await cookies();
  const wert = store.get(SIGNATURE_COOKIE)?.value;
  if (!wert) return null;
  try {
    const { payload } = await jwtVerify(wert, key(), { algorithms: ['HS256'] });
    if (payload.typ !== 'sig') return null;
    if (payload.scope !== 'sign' && payload.scope !== 'result') return null;
    if (
      typeof payload.jti !== 'string' ||
      typeof payload.req !== 'string' ||
      typeof payload.part !== 'string' ||
      typeof payload.tok !== 'string'
    ) {
      return null;
    }
    return {
      typ: 'sig',
      scope: payload.scope,
      jti: payload.jti,
      req: payload.req,
      part: payload.part,
      tok: payload.tok,
    };
  } catch {
    return null;
  }
}

export async function clearSignatureSession(): Promise<void> {
  const store = await cookies();
  store.set(SIGNATURE_COOKIE, '', { ...signatureCookieOptions(), maxAge: 0 });
}

/** Für das Protokoll: die Sitzung benennen, ohne ihr Geheimnis zu nennen. */
export function sessionRef(jti: string): string {
  return sha256Hex(jti);
}
