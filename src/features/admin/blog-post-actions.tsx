'use client';

import { Archive, Globe, PenLine, Trash2, Undo2 } from 'lucide-react';

import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';

/**
 * Beitrag bearbeiten, veröffentlichen, zurückziehen, löschen.
 *
 * Die Blogseite konnte bis hierher nur Entwürfe erzeugen (per KI); alles
 * Weitere — den Text redigieren, veröffentlichen, archivieren — ging nur über
 * die API. Der Statuswechsel verlangt `blog:publish`, das Redigieren
 * `blog:update`; die Seite zeigt deshalb nur, was die Rolle darf, und der
 * Endpunkt prüft es noch einmal.
 *
 * Ein veröffentlichter Beitrag lässt sich nicht löschen, nur archivieren —
 * seine Adresse ist verlinkt. Die Schaltfläche „Löschen" erscheint deshalb
 * nur bei Entwürfen und archivierten Beiträgen.
 */
export interface BlogPostValues {
  title: string;
  excerpt: string;
  content: string;
  categorySlug: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  keywords: string[];
}

export function BlogPostActions({
  postId,
  status,
  values,
  categories,
  canEdit,
  canPublish,
  canDelete,
}: {
  postId: string;
  status: string;
  values: BlogPostValues;
  categories: { slug: string; name: string }[];
  canEdit: boolean;
  canPublish: boolean;
  canDelete: boolean;
}) {
  const fields: FieldSpec[] = [
    { name: 'title', label: 'Titel', required: true },
    { name: 'excerpt', label: 'Anriss', type: 'textarea', rows: 2, required: true, hint: 'Erscheint in der Übersicht und in Suchmaschinen.' },
    { name: 'content', label: 'Beitrag', type: 'textarea', rows: 16, required: true },
    {
      name: 'categorySlug',
      label: 'Kategorie',
      type: 'select',
      half: true,
      options: categories.map((category) => ({ value: category.slug, label: category.name })),
      placeholder: 'Keine Kategorie',
      emptyAsString: true,
    },
    { name: 'keywords', label: 'Schlagwörter', type: 'tags', half: true },
    { name: 'seoTitle', label: 'Seitentitel (SEO)', half: true, emptyAsString: true },
    { name: 'seoDescription', label: 'Beschreibung (SEO)', half: true, emptyAsString: true },
  ];

  const published = status === 'PUBLISHED';

  return (
    <div className="flex items-center justify-end gap-1">
      {canPublish ? (
        published ? (
          <ActionButton
            endpoint={`/api/blog/${postId}`}
            method="PATCH"
            body={{ status: 'ARCHIVED' }}
            label="Zurückziehen"
            aria-label={`${values.title} zurückziehen`}
            variant="ghost"
            size="icon"
            confirmTitle="Beitrag zurückziehen?"
            confirm={`„${values.title}" wird archiviert und verschwindet von der Website. Die Adresse bleibt bekannt; der Beitrag lässt sich jederzeit wieder veröffentlichen.`}
            successMessage="Beitrag zurückgezogen."
          >
            <Archive aria-hidden />
          </ActionButton>
        ) : (
          <ActionButton
            endpoint={`/api/blog/${postId}`}
            method="PATCH"
            body={{ status: 'PUBLISHED' }}
            label={status === 'ARCHIVED' ? 'Wieder veröffentlichen' : 'Veröffentlichen'}
            aria-label={`${values.title} veröffentlichen`}
            variant="ghost"
            size="icon"
            successMessage="Beitrag veröffentlicht."
          >
            {status === 'ARCHIVED' ? <Undo2 aria-hidden /> : <Globe aria-hidden />}
          </ActionButton>
        )
      ) : null}
      {canEdit ? (
        <FormDialog
          title="Beitrag bearbeiten"
          triggerLabel="Bearbeiten"
          triggerVariant="ghost"
          triggerSize="icon"
          triggerIcon={<PenLine aria-hidden />}
          size="xl"
          endpoint={`/api/blog/${postId}`}
          method="PATCH"
          fields={fields}
          values={{
            ...values,
            categorySlug: values.categorySlug ?? '',
            seoTitle: values.seoTitle ?? '',
            seoDescription: values.seoDescription ?? '',
          }}
          successMessage="Beitrag gespeichert."
        />
      ) : null}
      {canDelete && !published ? (
        <ActionButton
          endpoint={`/api/blog/${postId}`}
          method="DELETE"
          label="Löschen"
          aria-label={`${values.title} löschen`}
          variant="ghost"
          size="icon"
          confirmTitle="Beitrag löschen?"
          confirm={`„${values.title}" wird endgültig entfernt. Ein Papierkorb gibt es für Beiträge nicht — archivieren Sie stattdessen, wenn Sie den Text später noch brauchen könnten.`}
          successMessage="Beitrag gelöscht."
        >
          <Trash2 aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}
