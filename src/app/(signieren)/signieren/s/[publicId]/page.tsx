import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { SigningFlow } from '@/features/signature/signing-flow';

export const metadata: Metadata = {
  title: 'Elektronisch unterzeichnen',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Die Unterzeichnungsseite. Die Adresse ist nicht geheim; alles, was sie
 * zeigt, holt sie über die Signatur-API mit dem Sitzungs-Cookie. Ohne
 * Sitzung antwortet die API 404, und die Seite sagt „nicht mehr gültig".
 */
export default async function SigningPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  if (!/^[0-9a-f]{32}$/.test(publicId)) notFound();
  return <SigningFlow publicId={publicId} />;
}
