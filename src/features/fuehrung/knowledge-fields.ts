import { ARTICLE_STATUS_LABELS, INSIGHT_KIND_LABELS, optionsOf } from '@/lib/bi/labels';
import type { FieldSpec } from './resource-form';

/** Felder für Wissensartikel, Wettbewerber und Marktbeobachtungen. */

export function articleFields(editing = false): FieldSpec[] {
  return [
    { name: 'title', label: 'Titel', required: true },
    { name: 'category', label: 'Kategorie', required: true, half: true, placeholder: 'Abläufe, Schulung, Richtlinien, FAQ …' },
    { name: 'status', label: 'Status', type: 'select', required: true, half: true, options: optionsOf(ARTICLE_STATUS_LABELS) },
    { name: 'visibility', label: 'Sichtbar für', type: 'select', required: true, half: true, options: [{ value: 'STAFF', label: 'Alle Mitarbeitenden' }, { value: 'OPERATIONS', label: 'Betriebsleitung und Geschäftsleitung' }, { value: 'MANAGEMENT', label: 'Nur Geschäftsleitung' }] },
    { name: 'tags', label: 'Schlagwörter', type: 'tags', half: true },
    { name: 'summary', label: 'Kurzfassung', half: true, nullable: editing },
    { name: 'videoUrl', label: 'Video-Link', type: 'url', half: true, placeholder: 'https://…', nullable: editing },
    { name: 'reviewIntervalDays', label: 'Prüfzyklus in Tagen', type: 'number', half: true, hint: 'Damit veraltete Anleitungen auffallen.', nullable: editing },
    { name: 'body', label: 'Inhalt', type: 'textarea', rows: 14, required: true, hint: 'Markdown: Überschriften mit #, Listen mit -, Fettdruck mit **.' },
  ];
}

export function competitorFields(editing = false): FieldSpec[] {
  return [
    { name: 'name', label: 'Name', required: true },
    { name: 'region', label: 'Region', half: true, placeholder: 'Bern, Thun, Biel …', nullable: editing },
    { name: 'website', label: 'Website', type: 'url', half: true, placeholder: 'https://…', nullable: editing },
    { name: 'services', label: 'Leistungen', type: 'tags', placeholder: 'Büroreinigung, Umzugsreinigung …' },
    { name: 'priceFrom', label: 'Preis von', type: 'number', half: true, suffix: 'CHF', nullable: editing },
    { name: 'priceTo', label: 'Preis bis', type: 'number', half: true, suffix: 'CHF', nullable: editing },
    { name: 'priceNote', label: 'Preisbemerkung', placeholder: 'je Stunde / je m² / Pauschale', nullable: editing },
    { name: 'reviewScore', label: 'Bewertungsschnitt', type: 'number', half: true, min: 0, max: 5, step: 0.1, nullable: editing },
    { name: 'reviewCount', label: 'Anzahl Bewertungen', type: 'number', half: true, nullable: editing },
    { name: 'marketPosition', label: 'Marktposition', placeholder: 'Preisführer, Premium, Nische …', nullable: editing },
    { name: 'strengths', label: 'Stärken', type: 'textarea', rows: 2, nullable: editing },
    { name: 'weaknesses', label: 'Schwächen', type: 'textarea', rows: 2, nullable: editing },
    { name: 'notes', label: 'Notizen', type: 'textarea', rows: 2, nullable: editing },
    { name: 'reviewIntervalDays', label: 'Prüfzyklus in Tagen', type: 'number', half: true, required: true },
  ];
}

export function insightFields(editing = false): FieldSpec[] {
  return [
    { name: 'title', label: 'Feststellung', required: true },
    { name: 'kind', label: 'Art', type: 'select', required: true, half: true, options: optionsOf(INSIGHT_KIND_LABELS) },
    { name: 'observedOn', label: 'Beobachtet am', type: 'date', required: true, half: true },
    { name: 'sourceName', label: 'Quelle', half: true, nullable: editing },
    { name: 'sourceUrl', label: 'Quellen-Link', type: 'url', half: true, placeholder: 'https://…', nullable: editing },
    { name: 'body', label: 'Was wurde beobachtet?', type: 'textarea', rows: 4, required: true },
    { name: 'impactNote', label: 'Bedeutung für uns', type: 'textarea', rows: 2, nullable: editing },
    { name: 'reviewIntervalDays', label: 'Gilt für Tage', type: 'number', half: true, required: true, hint: 'Danach gilt der Eintrag als veraltet und wird markiert.' },
  ];
}
