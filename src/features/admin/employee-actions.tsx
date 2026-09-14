'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Camera,
  KeyRound,
  Loader2,
  Lock,
  LockOpen,
  MailCheck,
  PenLine,
  ShieldOff,
  Trash2,
  UserRoundX,
} from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/api/client';
import { ActionButton } from '@/components/app/action-button';
import { FormDialog, type FieldSpec } from '@/components/app/resource-form';
import { ACCEPTED_IMAGE_TYPES, uploadImage } from '@/features/admin/image-field';
import { EMPLOYMENT_OPTIONS } from '@/features/admin/employee-labels';
import { Button } from '@/components/ui/button';
import { PersonAvatar } from '@/components/ui/primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';

/**
 * Personalakte: ändern, Foto, Konto, stilllegen.
 *
 * **Warum ein Dialog mit allen Feldern und nicht mehrere kleine.** Die Akte
 * wird selten und dann gründlich gepflegt — nach dem Vertragsgespräch, beim
 * Umzug, bei der Lohnrunde. Wer dafür fünf Dialoge öffnen muss, vergisst den
 * fünften. Das Formular ist lang, aber in der Reihenfolge der Akte: Konto,
 * Anstellung, Person, Bewilligung, Notfall, Notizen — und ganz unten, nur
 * mit Lohneinblick, die Zahlen.
 *
 * Lohn, AHV-Nummer und IBAN erscheinen nur, wenn die Seite sie auch liefert
 * (`sensitive`): Die Betriebsleitung bekommt sie vom Dienst gar nicht erst,
 * und ein Formularfeld, das leer ankommt und leer zurückgeht, würde beim
 * Speichern still eine gültige AHV-Nummer löschen.
 *
 * Konto-Handlungen (sperren, Zugangslink, Passwortwechsel erzwingen, zweiten
 * Faktor zurücksetzen) laufen über die Benutzer-Endpunkte, nicht über die
 * Akte: Es sind Handlungen am Login, und sie verlangen `user:update`, nicht
 * `employee:update`.
 *
 * Stilllegen ist kein Löschen (siehe `DELETE /api/employees/:id`): Die Akte
 * bleibt für Zeiterfassung und Lohnabrechnung erhalten, der Zugang wird
 * entzogen.
 */
export interface EmployeeEditValues {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  employeeNumber: string;
  position: string;
  department: string | null;
  employmentType: string;
  hiredAt: string;
  terminatedAt: string | null;
  workloadPct: number;
  vacationDaysPerYear: number;
  birthday: string | null;
  nationality: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  languages: string[];
  color: string;
  permitType: string | null;
  permitValidUntil: string | null;
  driverLicense: boolean;
  vehiclePlate: string | null;
  emergencyContact: string | null;
  emergencyPhone: string | null;
  notes: string | null;
  hourlyRate?: number | null;
  monthlySalary?: number | null;
  ahvNumber?: string | null;
  iban?: string | null;
}

const PERMIT_OPTIONS = ['CH', 'B', 'C', 'G', 'L', 'F', 'N'].map((value) => ({ value, label: value }));

const BASE_FIELDS: FieldSpec[] = [
  // Konto
  { name: 'firstName', label: 'Vorname', required: true, half: true },
  { name: 'lastName', label: 'Nachname', required: true, half: true },
  { name: 'email', label: 'E-Mail (Login)', type: 'email', required: true, half: true },
  { name: 'phone', label: 'Telefon', type: 'tel', half: true, nullable: true },
  // Anstellung
  { name: 'employeeNumber', label: 'Personalnummer', required: true, half: true },
  { name: 'position', label: 'Funktion', required: true, half: true },
  { name: 'department', label: 'Abteilung', half: true, nullable: true },
  { name: 'employmentType', label: 'Anstellung', type: 'select', required: true, half: true, options: EMPLOYMENT_OPTIONS },
  { name: 'hiredAt', label: 'Eintritt', type: 'date', required: true, half: true },
  { name: 'terminatedAt', label: 'Austritt', type: 'date', half: true, nullable: true, hint: 'Ein Austrittsdatum legt die Akte still und entzieht den Zugang.' },
  { name: 'workloadPct', label: 'Pensum', type: 'number', suffix: '%', half: true, min: 10, max: 100 },
  { name: 'vacationDaysPerYear', label: 'Ferienanspruch', type: 'number', suffix: 'Tage', half: true, min: 0, max: 60 },
  // Person
  { name: 'birthday', label: 'Geburtsdatum', type: 'date', half: true, nullable: true },
  { name: 'nationality', label: 'Nationalität', half: true, nullable: true },
  { name: 'street', label: 'Strasse und Nummer', nullable: true },
  { name: 'postalCode', label: 'PLZ', half: true, nullable: true },
  { name: 'city', label: 'Ort', half: true, nullable: true },
  { name: 'languages', label: 'Sprachen', type: 'tags', half: true, hint: 'DE, FR, IT, EN — mit Komma trennen.' },
  { name: 'color', label: 'Kalenderfarbe', half: true, placeholder: '#0B7285' },
  // Bewilligung und Fahrzeug
  { name: 'permitType', label: 'Bewilligung', type: 'select', half: true, options: PERMIT_OPTIONS, nullable: true },
  { name: 'permitValidUntil', label: 'Bewilligung gültig bis', type: 'date', half: true, nullable: true },
  { name: 'driverLicense', label: 'Führerausweis vorhanden', type: 'checkbox' },
  { name: 'vehiclePlate', label: 'Kontrollschild', half: true, nullable: true },
  // Notfall
  { name: 'emergencyContact', label: 'Notfallkontakt', half: true, nullable: true },
  { name: 'emergencyPhone', label: 'Notfallnummer', type: 'tel', half: true, nullable: true },
  // Notizen
  { name: 'notes', label: 'Interne Notizen', type: 'textarea', rows: 3, nullable: true, hint: 'Nur für die Personalverwaltung sichtbar.' },
];

const SENSITIVE_FIELDS: FieldSpec[] = [
  { name: 'hourlyRate', label: 'Stundenansatz', type: 'number', suffix: 'CHF', half: true, nullable: true },
  { name: 'monthlySalary', label: 'Monatslohn (100 %)', type: 'number', suffix: 'CHF', half: true, nullable: true },
  { name: 'salaryValidFrom', label: 'Neuer Lohn gültig ab', type: 'date', half: true, hint: 'Leer: ab heute. Jede Lohn- oder Pensumsänderung landet in der Lohnhistorie.' },
  { name: 'salaryReason', label: 'Grund der Lohnänderung', half: true, placeholder: 'Lohnrunde 2027, Beförderung …' },
  { name: 'ahvNumber', label: 'AHV-Nummer', half: true, nullable: true, placeholder: '756.1234.5678.90' },
  { name: 'iban', label: 'IBAN', half: true, nullable: true },
];

export function EmployeeEditDialog({
  employeeId,
  values,
  sensitive,
}: {
  employeeId: string;
  values: EmployeeEditValues;
  sensitive: boolean;
}) {
  return (
    <FormDialog
      title="Personalakte bearbeiten"
      description="Konto, Anstellung, Person, Bewilligung, Notfallkontakt und Notizen. Die Rolle des Kontos ändern Sie in der Benutzerverwaltung."
      triggerLabel="Bearbeiten"
      triggerVariant="outline"
      plainTrigger
      triggerIcon={<PenLine aria-hidden />}
      size="xl"
      endpoint={`/api/employees/${employeeId}`}
      method="PATCH"
      fields={sensitive ? [...BASE_FIELDS, ...SENSITIVE_FIELDS] : BASE_FIELDS}
      values={{
        ...values,
        phone: values.phone ?? '',
        department: values.department ?? '',
        terminatedAt: values.terminatedAt ?? '',
        birthday: values.birthday ?? '',
        nationality: values.nationality ?? '',
        street: values.street ?? '',
        postalCode: values.postalCode ?? '',
        city: values.city ?? '',
        permitType: values.permitType ?? '',
        permitValidUntil: values.permitValidUntil ?? '',
        vehiclePlate: values.vehiclePlate ?? '',
        emergencyContact: values.emergencyContact ?? '',
        emergencyPhone: values.emergencyPhone ?? '',
        notes: values.notes ?? '',
        hourlyRate: values.hourlyRate ?? '',
        monthlySalary: values.monthlySalary ?? '',
        salaryValidFrom: '',
        salaryReason: '',
        ahvNumber: values.ahvNumber ?? '',
        iban: values.iban ?? '',
      }}
      successMessage="Personalakte gespeichert."
    />
  );
}

/**
 * Profilbild durch die Verwaltung setzen.
 *
 * Läuft über `PATCH /api/users/:id` — dieselbe Stelle, an der die Person
 * ihr Bild selbst pflegt, nur mit `user:update` statt der eigenen Sitzung.
 * Kein Zuschneiden wie im Selbstbedienungs-Uploader: Die Verwaltung legt in
 * der Regel ein bereits aufbereitetes Teamfoto ab.
 */
export function EmployeePhotoDialog({
  userId,
  firstName,
  lastName,
  avatarUrl,
  color,
}: {
  userId: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  color: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);

  const save = async (url: string) => {
    await api.patch(`/api/users/${userId}`, { avatarUrl: url });
    router.refresh();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await save(await uploadImage(file, 'avatar'));
      toast.success('Profilbild gespeichert.');
      setOpen(false);
    } catch (err) {
      toast.error(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'Das Profilbild konnte nicht gespeichert werden.',
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await save('');
      toast.success('Profilbild entfernt.');
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Das Profilbild konnte nicht entfernt werden.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Camera aria-hidden />
        Foto
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Profilbild</DialogTitle>
            <DialogDescription>
              JPEG, PNG oder WebP. Das Bild erscheint in Kalender, Einsatzplanung und im Portal
              der Person.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-4">
            <PersonAvatar
              firstName={firstName}
              lastName={lastName}
              src={avatarUrl}
              color={color}
              size="lg"
            />
            <label
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                void upload(event.dataTransfer.files[0]);
              }}
              className={cn(
                'flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed p-4 text-center text-sm transition-colors',
                dragging ? 'border-primary bg-primary/[0.06]' : 'border-border hover:bg-muted/40',
                busy && 'pointer-events-none opacity-60',
              )}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin text-primary" aria-hidden />
              ) : (
                <Camera className="size-4 text-muted-foreground" aria-hidden />
              )}
              <span className="font-medium">{busy ? 'Wird gespeichert …' : 'Bild wählen oder hierher ziehen'}</span>
              <input
                type="file"
                accept={ACCEPTED_IMAGE_TYPES.join(',')}
                className="sr-only"
                disabled={busy}
                onChange={(event) => {
                  void upload(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
            </label>
          </div>

          <DialogFooter>
            {avatarUrl ? (
              <Button variant="ghost" onClick={remove} disabled={busy} className="mr-auto text-muted-foreground hover:text-destructive">
                <Trash2 aria-hidden />
                Entfernen
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Schliessen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Handlungen am Login der Person — Sperre, Zugangslink, Passwortzwang, zweiter Faktor. */
export function EmployeeAccountActions({
  userId,
  email,
  status,
  twoFactorEnabled,
  mustChangePassword,
  canResetTwoFactor,
  self,
}: {
  userId: string;
  email: string;
  status: string;
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  canResetTwoFactor: boolean;
  self: boolean;
}) {
  const blocked = status === 'SUSPENDED' || status === 'DISABLED';

  return (
    <div className="flex flex-wrap gap-2 py-4">
      {!self ? (
        blocked ? (
          <ActionButton
            endpoint={`/api/users/${userId}`}
            method="PATCH"
            body={{ status: 'ACTIVE' }}
            label="Zugang freigeben"
            variant="outline"
            size="sm"
            confirmTitle="Zugang freigeben?"
            confirm={`${email} kann sich danach wieder anmelden.`}
            successMessage="Zugang freigegeben."
          >
            <LockOpen aria-hidden />
          </ActionButton>
        ) : (
          <ActionButton
            endpoint={`/api/users/${userId}`}
            method="PATCH"
            body={{ status: 'SUSPENDED' }}
            label="Zugang sperren"
            variant="outline"
            size="sm"
            confirmTitle="Zugang sperren?"
            confirm={`${email} wird sofort abgemeldet und kann sich nicht mehr anmelden. Die Personalakte bleibt aktiv — zum Austritt nutzen Sie „Stilllegen".`}
            successMessage="Zugang gesperrt — alle Sitzungen beendet."
          >
            <Lock aria-hidden />
          </ActionButton>
        )
      ) : null}

      {!blocked ? (
        <ActionButton
          endpoint={`/api/users/${userId}/password-reset`}
          method="POST"
          label={status === 'PENDING' ? 'Einladung erneut senden' : 'Passwort-Link senden'}
          variant="outline"
          size="sm"
          confirmTitle={status === 'PENDING' ? 'Einladung erneut senden?' : 'Passwort-Link senden?'}
          confirm={
            status === 'PENDING'
              ? `${email} erhält eine neue Einladung mit frischem Link; der alte verfällt.`
              : `${email} erhält einen einmaligen Link zum Setzen eines neuen Passworts. Das bisherige Passwort bleibt bis dahin gültig.`
          }
          successMessage={status === 'PENDING' ? 'Einladung versendet.' : 'Passwort-Link versendet.'}
        >
          <MailCheck aria-hidden />
        </ActionButton>
      ) : null}

      {!self && !blocked && !mustChangePassword ? (
        <ActionButton
          endpoint={`/api/users/${userId}`}
          method="PATCH"
          body={{ mustChangePassword: true }}
          label="Passwortwechsel erzwingen"
          variant="outline"
          size="sm"
          confirmTitle="Passwortwechsel erzwingen?"
          confirm={`${email} wird abgemeldet und muss bei der nächsten Anmeldung ein neues Passwort setzen.`}
          successMessage="Passwortwechsel erzwungen — Sitzungen beendet."
        >
          <KeyRound aria-hidden />
        </ActionButton>
      ) : null}

      {canResetTwoFactor && !self && twoFactorEnabled ? (
        <ActionButton
          endpoint={`/api/users/${userId}/2fa`}
          method="DELETE"
          label="Zwei-Faktor zurücksetzen"
          variant="outline"
          size="sm"
          confirmTitle="Zwei-Faktor-Anmeldung zurücksetzen?"
          confirm={`${email} meldet sich danach nur noch mit dem Passwort an und muss den zweiten Faktor neu einrichten. Alle Sitzungen werden beendet.`}
          successMessage="Zwei-Faktor-Anmeldung zurückgesetzt."
        >
          <ShieldOff aria-hidden />
        </ActionButton>
      ) : null}
    </div>
  );
}

export function EmployeeDeactivateButton({
  employeeId,
  name,
  active,
}: {
  employeeId: string;
  name: string;
  active: boolean;
}) {
  if (!active) {
    return (
      <ActionButton
        endpoint={`/api/employees/${employeeId}`}
        method="PATCH"
        body={{ active: true }}
        label="Wieder aktivieren"
        variant="outline"
        size="default"
        confirmTitle="Person wieder aktivieren?"
        confirm={`${name} erscheint wieder in Disposition und Zuteilung; das Austrittsdatum wird gelöscht. Den Zugang zum Portal geben Sie im Abschnitt „Konto" frei.`}
        successMessage="Person wieder aktiviert."
      />
    );
  }

  return (
    <ActionButton
      endpoint={`/api/employees/${employeeId}`}
      method="DELETE"
      label="Stilllegen"
      variant="outline"
      size="default"
      confirmTitle="Person stilllegen?"
      confirm={`${name} wird als ausgetreten geführt und kann sich nicht mehr anmelden. Zeiterfassung, Lohnabrechnungen und Einsatzrapporte bleiben erhalten. Sind noch Einsätze zugeteilt, verweigert der Server den Schritt.`}
      successMessage="Person stillgelegt."
    >
      <UserRoundX aria-hidden />
    </ActionButton>
  );
}
