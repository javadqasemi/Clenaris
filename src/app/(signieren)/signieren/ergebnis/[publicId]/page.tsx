import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { ResultView } from '@/features/signature/result-view';

export const metadata: Metadata = {
  title: 'Unterzeichnung — Ergebnis',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default async function ResultPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  if (!/^[0-9a-f]{32}$/.test(publicId)) notFound();
  return <ResultView publicId={publicId} />;
}
