/**
 * Die Bausteine sind in die gemeinsame Komponentenbibliothek gewandert, weil
 * sie inzwischen jeder Bereich braucht — nicht nur die Unternehmensführung.
 * Dieser Verweis hält die bestehenden Importe am Leben.
 */
export {
  ResourceForm,
  FormDialog,
  DialogFooter,
  buildPayload,
  type FieldSpec,
  type FieldValues,
  type ResourceFormProps,
  type FormDialogProps,
} from '@/components/app/resource-form';
