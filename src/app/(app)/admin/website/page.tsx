import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';

import { getSession, requirePagePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-parts';
import {
  WebsiteWorkspace,
  type WebsiteData,
  type WebsiteRights,
} from '@/features/admin/website/website-workspace';
import { listFaqs, listGalleryItems } from '@/server/services/website.service';
import { listLegalDocuments, listNavItems } from '@/server/services/navigation.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Website-Inhalte',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Häufige Fragen, Galerie, Navigation und Rechtstexte.
 *
 * Alles auf einer Seite, weil es dieselbe Frage beantwortet: was steht auf der
 * Website. Wer die Navigation pflegt, merkt regelmässig, dass ein Ziel noch
 * fehlt — und soll dann nicht navigieren müssen.
 */
export default async function WebsitePage() {
  await requirePagePermission('faq:read');
  const session = await getSession();
  const role = session!.role;
  const organizationId = await getOrganizationId();

  const [faqs, gallery, navigation, legal] = await Promise.all([
    listFaqs(organizationId),
    listGalleryItems(organizationId),
    listNavItems(organizationId),
    listLegalDocuments(organizationId),
  ]);

  const data: WebsiteData = {
    faqs: faqs.map((faq) => ({
      id: faq.id,
      question: faq.question,
      answer: faq.answer,
      category: faq.category,
      locale: faq.locale,
      position: faq.position,
      active: faq.active,
    })),

    gallery: gallery.map((item) => ({
      id: item.id,
      title: item.title,
      description: item.description,
      serviceKind: item.serviceKind,
      beforeUrl: item.beforeUrl,
      afterUrl: item.afterUrl,
      location: item.location,
      featured: item.featured,
      position: item.position,
      published: item.published,
    })),

    navigation: navigation.map((item) => ({
      id: item.id,
      location: item.location,
      label: item.label,
      href: item.href,
      description: item.description,
      icon: item.icon,
      newTab: item.newTab,
      parentId: item.parentId,
      position: item.position,
      active: item.active,
    })),

    legal: legal.map((doc) => ({
      id: doc.id,
      slug: doc.slug,
      title: doc.title,
      body: doc.body,
      version: doc.version,
      effectiveFrom: doc.effectiveFrom ? new Date(doc.effectiveFrom).toISOString() : null,
    })),
  };

  const rights: WebsiteRights = {
    faq: {
      create: can(role, 'faq:create'),
      update: can(role, 'faq:update'),
      delete: can(role, 'faq:delete'),
    },
    gallery: {
      create: can(role, 'gallery:create'),
      update: can(role, 'gallery:update'),
      delete: can(role, 'gallery:delete'),
    },
    navigation: { update: can(role, 'navigation:update') },
    legal: { update: can(role, 'legal:update') },
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Website-Inhalte"
        description="Häufige Fragen, Referenzbilder, Menüstruktur und Rechtstexte. Änderungen erscheinen sofort auf der öffentlichen Website."
        actions={
          <Button asChild variant="outline">
            <Link href="/" target="_blank" rel="noopener noreferrer">
              <ExternalLink aria-hidden />
              Website ansehen
            </Link>
          </Button>
        }
      />

      <WebsiteWorkspace data={data} rights={rights} />
    </div>
  );
}
