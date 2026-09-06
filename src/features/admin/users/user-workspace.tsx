'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Lock, LockOpen, Mail, Pencil, RotateCcw, Send, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api/client';
import { formatDate } from '@/lib/utils';
import { ROLE_LABELS } from '@/lib/auth/rbac';
import {
  inviteUserSchema,
  updateUserSchema,
  USER_STATUS_LABELS,
  type InviteUserInput,
  type UpdateUserInput,
} from '@/lib/validation/users';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/primitives';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/controls';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/overlays';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { EmptyState, ListCard, TableScroll } from '@/components/app/page-parts';

/**
 * Benutzerkonten verwalten.
 *
 * Gestaltungsentscheide:
 *
 *  • **Sperren steht neben Löschen, nicht darin.** Ein gesperrtes Konto ist
 *    der Normalfall beim Austritt; gelöscht wird selten. Beides in einem Menü
 *    zu verstecken macht die häufige Handlung teurer als die seltene.
 *
 *  • **Die Rollenspalte ist ein Auswahlfeld, kein Text — aber nur für die
 *    Systemverantwortung.** Für alle anderen steht dort schlicht die Rolle.
 *    Ein ausgegrautes Auswahlfeld würde suggerieren, es fehle nur ein Klick.
 *
 *  • **Das eigene Konto ist erkennbar und nicht bearbeitbar.** Die Sperren
 *    dafür liegen im Dienst; hier fehlen die Schaltflächen, damit niemand
 *    gegen eine Wand läuft.
 */

export interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: string;
  status: string;
  locale: string;
  twoFactorEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  deletedAt: string | null;
  linkedTo: string | null;
}

export function UserWorkspace({
  users,
  trashed,
  currentUserId,
  assignableRoles,
  canCreate,
  canUpdate,
  canDelete,
  canAssignRole,
}: {
  users: UserRow[];
  trashed: UserRow[];
  currentUserId: string;
  assignableRoles: string[];
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canAssignRole: boolean;
}) {
  const router = useRouter();
  const [inviting, setInviting] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);
  const [deleting, setDeleting] = React.useState<UserRow | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const act = async (id: string, run: () => Promise<unknown>, success: string) => {
    setBusy(id);
    try {
      await run();
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Die Aktion ist fehlgeschlagen.');
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (row: UserRow, status: 'ACTIVE' | 'SUSPENDED') =>
    act(
      row.id,
      () => api.patch(`/api/users/${row.id}`, { status }),
      status === 'ACTIVE'
        ? `${row.firstName} ${row.lastName} ist wieder freigeschaltet.`
        : `${row.firstName} ${row.lastName} ist gesperrt — alle Sitzungen wurden beendet.`,
    );

  const changeRole = (row: UserRow, role: string) =>
    act(
      row.id,
      () => api.patch(`/api/users/${row.id}/role`, { role }),
      `${row.firstName} ${row.lastName} ist jetzt ${ROLE_LABELS[role as keyof typeof ROLE_LABELS]}.`,
    );

  const restore = (row: UserRow) =>
    act(
      row.id,
      () => api.post(`/api/users/${row.id}/restore`),
      `${row.email} wiederhergestellt — noch gesperrt.`,
    );

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {users.length} {users.length === 1 ? 'Konto' : 'Konten'} ·{' '}
          {users.filter((u) => u.status === 'ACTIVE').length} aktiv
        </p>
        {canCreate ? (
          <Button onClick={() => setInviting(true)}>
            <UserPlus aria-hidden />
            Person einladen
          </Button>
        ) : null}
      </div>

      {users.length === 0 ? (
        <EmptyState
          title="Keine Konten gefunden"
          description="Konten entstehen durch eine Einladung oder durch die Registrierung einer Kundschaft auf der Website."
        />
      ) : (
        <ListCard>
          <TableScroll minWidth="58rem">
            <table className="data-table data-table--sticky">
              <caption className="sr-only">Benutzerkonten der Organisation.</caption>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Rolle</th>
                  <th scope="col">Status</th>
                  <th scope="col">Verknüpft</th>
                  <th scope="col">Letzte Anmeldung</th>
                  <th scope="col" className="text-right">
                    <span className="sr-only">Aktionen</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((row) => {
                  const self = row.id === currentUserId;
                  return (
                    <tr key={row.id}>
                      <td className="cell-wide">
                        <span className="flex flex-wrap items-center gap-2 font-medium">
                          {row.firstName} {row.lastName}
                          {self ? (
                            <Badge variant="info" size="sm">
                              Sie
                            </Badge>
                          ) : null}
                          {row.twoFactorEnabled ? (
                            <ShieldCheck
                              className="size-3.5 text-success"
                              aria-label="Zwei-Faktor aktiv"
                            />
                          ) : null}
                        </span>
                        <span className="block text-xs text-muted-foreground">{row.email}</span>
                      </td>

                      <td>
                        {canAssignRole && !self ? (
                          <Select
                            value={row.role}
                            onValueChange={(value) => changeRole(row, value)}
                            disabled={busy !== null}
                          >
                            <SelectTrigger
                              className="h-9 w-auto min-w-[11rem]"
                              aria-label={`Rolle von ${row.firstName} ${row.lastName}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {assignableRoles.map((role) => (
                                <SelectItem key={role} value={role}>
                                  {ROLE_LABELS[role as keyof typeof ROLE_LABELS]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-muted-foreground">
                            {ROLE_LABELS[row.role as keyof typeof ROLE_LABELS] ?? row.role}
                          </span>
                        )}
                      </td>

                      <td>
                        <StatusBadge status={row.status} />
                      </td>

                      <td className="text-muted-foreground">{row.linkedTo ?? '—'}</td>

                      <td className="whitespace-nowrap text-muted-foreground">
                        {row.lastLoginAt ? formatDate(new Date(row.lastLoginAt)) : 'nie'}
                      </td>

                      <td>
                        <div className="flex items-center justify-end gap-0.5">
                          {canUpdate && !self ? (
                            row.status === 'ACTIVE' ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={busy === row.id}
                                onClick={() => setStatus(row, 'SUSPENDED')}
                              >
                                <Lock aria-hidden />
                                Sperren
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={busy === row.id}
                                onClick={() => setStatus(row, 'ACTIVE')}
                              >
                                <LockOpen aria-hidden />
                                Freigeben
                              </Button>
                            )
                          ) : null}

                          {canUpdate ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${row.email} bearbeiten`}
                              onClick={() => setEditing(row)}
                            >
                              <Pencil aria-hidden />
                            </Button>
                          ) : null}

                          {canDelete && !self ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`${row.email} löschen`}
                              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              onClick={() => setDeleting(row)}
                            >
                              <Trash2 aria-hidden />
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        </ListCard>
      )}

      {trashed.length > 0 ? (
        <ListCard title={`Papierkorb (${trashed.length})`}>
          <Alert variant="info" className="mx-5 mt-5">
            Gelöschte Konten behalten ihre Historie in Aktivitäten, Nachrichten und Prüfprotokoll.
            Wiederhergestellte Konten kommen gesperrt zurück.
          </Alert>
          <ul className="divide-y divide-border">
            {trashed.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {row.firstName} {row.lastName}
                  </p>
                  <p className="text-meta text-muted-foreground">
                    {row.email} · {ROLE_LABELS[row.role as keyof typeof ROLE_LABELS] ?? row.role}
                  </p>
                </div>
                {canDelete ? (
                  <Button
                    variant="outline"
                    size="sm"
                    loading={busy === row.id}
                    onClick={() => restore(row)}
                  >
                    <RotateCcw aria-hidden />
                    Wiederherstellen
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </ListCard>
      ) : null}

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        assignableRoles={assignableRoles}
      />
      <EditDialog user={editing} onClose={() => setEditing(null)} />
      <DeleteDialog user={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, 'success' | 'warning' | 'neutral' | 'info'> = {
    ACTIVE: 'success',
    PENDING: 'info',
    SUSPENDED: 'warning',
    DISABLED: 'neutral',
  };
  return (
    <Badge variant={map[status] ?? 'neutral'} size="sm">
      {USER_STATUS_LABELS[status as keyof typeof USER_STATUS_LABELS] ?? status}
    </Badge>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  assignableRoles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assignableRoles: string[];
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<InviteUserInput>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: { email: '', firstName: '', lastName: '', role: 'EMPLOYEE', locale: 'DE' } as never,
  });

  React.useEffect(() => {
    if (open) {
      form.reset({ email: '', firstName: '', lastName: '', role: 'EMPLOYEE', locale: 'DE' } as never);
      setError(null);
    }
  }, [open, form]);

  const onSubmit = async (values: InviteUserInput) => {
    setError(null);
    try {
      await api.post('/api/users', values);
      toast.success(`Einladung an ${values.email} versendet.`);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Die Einladung konnte nicht versendet werden.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Person einladen</DialogTitle>
          <DialogDescription>
            Die Person erhält eine E-Mail mit einem einmaligen Link und vergibt ihr Passwort selbst.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Vorname</FormLabel>
                    <FormControl>
                      <Input autoComplete="given-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel required>Nachname</FormLabel>
                    <FormControl>
                      <Input autoComplete="family-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>E-Mail</FormLabel>
                  <FormControl>
                    <Input type="email" startIcon={<Mail />} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>Rolle</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {assignableRoles.map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role as keyof typeof ROLE_LABELS]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Was die Rolle erlaubt, steht unter „Rollen und Rechte&ldquo;.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                <Send aria-hidden />
                Einladung senden
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  const form = useForm<UpdateUserInput>({ resolver: zodResolver(updateUserSchema) });

  React.useEffect(() => {
    if (!user) return;
    form.reset({
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone ?? undefined,
      locale: user.locale as UpdateUserInput['locale'],
    });
    setError(null);
  }, [user, form]);

  const onSubmit = async (values: UpdateUserInput) => {
    if (!user) return;
    setError(null);
    try {
      await api.patch(`/api/users/${user.id}`, values);
      toast.success('Konto gespeichert.');
      onClose();
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Speichern fehlgeschlagen.';
      setError(message);
      toast.error(message);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Konto bearbeiten</DialogTitle>
          <DialogDescription>
            Die Rolle wird in der Liste geändert, das Passwort setzt die Person selbst zurück.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert variant="destructive">{error}</Alert> : null}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5" noValidate>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Vorname</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nachname</FormLabel>
                    <FormControl>
                      <Input {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>E-Mail</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Telefon</FormLabel>
                    <FormControl>
                      <Input type="tel" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Abbrechen
              </Button>
              <Button type="submit" loading={form.formState.isSubmitting}>
                Speichern
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (user) setError(null);
  }, [user]);

  const confirm = async () => {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/api/users/${user.id}`);
      toast.success(`${user.email} gelöscht.`);
      onClose();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Löschen fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={user !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Konto löschen?</DialogTitle>
          <DialogDescription>
            {user
              ? `${user.firstName} ${user.lastName} verliert sofort den Zugang und alle Sitzungen werden beendet. Die Historie in Aktivitäten, Nachrichten und Prüfprotokoll bleibt erhalten; das Konto lässt sich wiederherstellen.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p
            role="alert"
            className="rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
          <Button variant="destructive" onClick={confirm} loading={busy}>
            In den Papierkorb
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
