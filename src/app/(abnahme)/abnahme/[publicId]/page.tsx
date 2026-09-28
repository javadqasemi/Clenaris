import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SigningFlow } from '@/features/signature/signing-flow';

export const metadata: Metadata = {
  title: 'Rapport abnehmen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Der Kundenmodus auf dem übergebenen Gerät.
 *
 * Die Adresse trägt nur die nicht geheime Kennung des Vorgangs — kein
 * Token, kein Fragment, nichts, was jemand aus dem Verlauf lesen könnte.
 * Was die Seite zeigt, holt sie über die Signatur-API mit dem
 * Signaturcookie, das die Startroute gesetzt hat; ohne dieses Cookie
 * antwortet die API 404 und die Seite sagt „nicht mehr gültig".
 *
 * Unterzeichnet wird derselbe Ablauf wie beim Link (`SigningFlow`) — eine
 * zweite Signaturmaske neben der bestehenden wäre eine zweite Stelle, an der
 * Zustimmung, Methode und Abschluss auseinanderlaufen könnten. Nur die Worte
 * am Ende sind andere: Hier folgt keine E-Mail, sondern die Bitte, das Gerät
 * zurückzugeben.
 */
export default async function AbnahmePage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  if (!/^[0-9a-f]{32}$/.test(publicId)) notFound();
  return <SigningFlow publicId={publicId} variant="vor-ort" />;
}
