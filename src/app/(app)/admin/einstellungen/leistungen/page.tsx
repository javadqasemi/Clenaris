import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { toNumber } from '@/lib/db';
import { getSession, requirePermission } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/primitives';
import { PageHeader } from '@/components/app/page-parts';
import { CatalogWorkspace, type CatalogData } from '@/features/admin/catalog/catalog-workspace';
import {
  listCategories,
  listCoupons,
  listExtras,
  listPriceRules,
  listServices,
  listTaxRates,
} from '@/server/services/catalog.service';
import { getOrganizationId } from '@/server/services/organization.service';

export const metadata: Metadata = {
  title: 'Leistungen und Preise',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

/**
 * Leistungskatalog und Preislogik — mit Bearbeitung.
 *
 * Warum das Bearbeiten hier sicher ist: `BookingItem` und `InvoiceItem`
 * speichern Name, Einzelpreis und Steuersatz als *eigene Spalten*, nicht als
 * Verweis auf die Leistung. Eine Preisänderung wirkt deshalb ab dem nächsten
 * Vorgang; bestehende Buchungen und Rechnungen behalten die Zahlen, mit denen
 * sie entstanden sind. Ohne diesen Abzug wäre eine Bearbeitungsmaske
 * tatsächlich gefährlich — sie würde rückwirkend die Herleitung alter Belege
 * unlesbar machen.
 *
 * Die Seite lädt auf dem Server und reicht fertige Zeilen weiter. Alle
 * `Decimal`-Spalten werden dabei in Zahlen übersetzt: sie müssen die Grenze
 * zur Client-Komponente überqueren, und die Dezimalobjekte von Prisma sind
 * nicht serialisierbar.
 */
export default async function ServiceSettingsPage() {
  await requirePermission('service:read');
  const session = await getSession();
  const organizationId = await getOrganizationId();

  const [services, extras, rules, categories, taxRates, coupons] = await Promise.all([
    listServices(organizationId),
    listExtras(organizationId),
    listPriceRules(organizationId),
    listCategories(organizationId),
    listTaxRates(organizationId),
    listCoupons(organizationId),
  ]);

  const data: CatalogData = {
    services: services.map((service) => ({
      id: service.id,
      slug: service.slug,
      kind: service.kind,
      name: service.name,
      shortDesc: service.shortDesc,
      description: service.description,
      icon: service.icon,
      heroImage: service.heroImage,
      active: service.active,
      featured: service.featured,
      position: service.position,
      categoryId: service.categoryId,
      pricingModel: service.pricingModel,
      basePrice: toNumber(service.basePrice),
      hourlyRate: service.hourlyRate === null ? null : toNumber(service.hourlyRate),
      pricePerSqm: service.pricePerSqm === null ? null : toNumber(service.pricePerSqm),
      minPrice: toNumber(service.minPrice),
      minHours: toNumber(service.minHours),
      vatRate: toNumber(service.vatRate),
      defaultDurationMin: service.defaultDurationMin,
      minutesPerSqm: toNumber(service.minutesPerSqm),
      defaultCrewSize: service.defaultCrewSize,
      bufferMinutes: service.bufferMinutes,
      bulletPoints: service.bulletPoints,
      includes: service.includes,
      excludes: service.excludes,
      seoTitle: service.seoTitle,
      seoDescription: service.seoDescription,
      keywords: service.keywords,
    })),

    extras: extras.map((extra) => ({
      id: extra.id,
      slug: extra.slug,
      name: extra.name,
      description: extra.description,
      icon: extra.icon,
      price: toNumber(extra.price),
      pricingModel: extra.pricingModel,
      durationMin: extra.durationMin,
      vatRate: toNumber(extra.vatRate),
      active: extra.active,
      position: extra.position,
      serviceIds: extra.services.map((link) => link.serviceId),
    })),

    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      serviceId: rule.serviceId,
      condition: (rule.condition ?? {}) as Record<string, unknown>,
      multiplier: toNumber(rule.multiplier),
      surcharge: toNumber(rule.surcharge),
      priority: rule.priority,
      active: rule.active,
    })),

    categories: categories.map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      description: category.description,
      icon: category.icon,
      position: category.position,
      active: category.active,
    })),

    taxRates: taxRates.map((rate) => ({
      id: rate.id,
      name: rate.name,
      rate: toNumber(rate.rate),
      isDefault: rate.isDefault,
      active: rate.active,
    })),

    coupons: coupons.map((coupon) => ({
      id: coupon.id,
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: toNumber(coupon.discountValue),
      minOrderValue: toNumber(coupon.minOrderValue),
      maxDiscount: coupon.maxDiscount === null ? null : toNumber(coupon.maxDiscount),
      status: coupon.status,
      validFrom: coupon.validFrom.toISOString(),
      validUntil: coupon.validUntil?.toISOString() ?? null,
      usageLimit: coupon.usageLimit,
      usageCount: coupon.usageCount,
      perCustomerLimit: coupon.perCustomerLimit,
      firstOrderOnly: coupon.firstOrderOnly,
      serviceKinds: coupon.serviceKinds,
    })),

    // Verwendungszahlen steuern, was die Löschbestätigung *vorher* sagt. Der
    // Server lehnt ohnehin ab — aber es vorher zu wissen erspart den Umweg
    // über eine Fehlermeldung.
    serviceUsage: Object.fromEntries(
      services.map((service) => [
        service.id,
        service._count.bookings + service._count.jobs,
      ]),
    ),
    extraUsage: Object.fromEntries(extras.map((extra) => [extra.id, extra._count.bookings])),
    categoryUsage: Object.fromEntries(
      categories.map((category) => [category.id, category._count.services]),
    ),
  };

  const role = session!.role;
  const canWrite = can(role, 'service:update');

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3">
        <Link href="/admin/einstellungen">
          <ArrowLeft aria-hidden />
          Einstellungen
        </Link>
      </Button>

      <PageHeader
        title="Leistungen und Preise"
        description="Der Katalog, aus dem die Preis-Engine rechnet. Änderungen erscheinen nach dem Speichern auf der Website und gelten ab dem nächsten Vorgang."
        actions={
          <Button asChild variant="outline">
            <Link href="/leistungen">
              <ExternalLink aria-hidden />
              Öffentliche Ansicht
            </Link>
          </Button>
        }
      />

      {canWrite ? (
        <Alert variant="info">
          Preise werden ausschliesslich auf dem Server berechnet. Bestehende Buchungen und
          Rechnungen behalten ihre Zahlen — jede Position trägt Preis und Steuersatz als eigenen
          Wert.
        </Alert>
      ) : (
        <Alert variant="default">
          Sie sehen den Katalog, können ihn aber nicht ändern. Leistungen, Preise und Gutscheine
          verantwortet die Geschäftsleitung.
        </Alert>
      )}

      <CatalogWorkspace
        data={data}
        canWrite={canWrite}
        canWriteTaxRates={can(role, 'pricing:update')}
        canWriteCoupons={can(role, 'coupon:update')}
      />
    </div>
  );
}
