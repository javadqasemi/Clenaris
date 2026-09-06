import type { NavGroup } from '@/components/app/app-shell';
import { can, canAny, type ActorRole, type Permission } from './rbac';

/**
 * Navigation nach Berechtigung filtern.
 *
 * Warum ein eigenes Modul und nicht eine Bedingung je Menüpunkt: die
 * Navigation wird in drei Layouts aufgebaut, und eine dort ausgeschriebene
 * Prüfung wäre dreimal leicht anders. Vor allem aber muss der Filter *vor*
 * dem Rendern greifen — ein Menüpunkt, den erst CSS ausblendet, steht im
 * ausgelieferten HTML und ist damit ein Wegweiser auf eine Seite, die man
 * nicht betreten darf.
 *
 * Der Filter ist eine Bequemlichkeit, keine Autorisierung. Wer den Pfad kennt
 * und direkt eingibt, wird von der Middleware und von `requirePagePermission`
 * abgewiesen — hier geht es nur darum, niemandem eine Tür zu zeigen, die für
 * ihn verschlossen ist.
 *
 * Eine Gruppe, die dadurch leer wird, verschwindet mit: eine Überschrift ohne
 * Einträge ist ein Hinweis auf etwas Verborgenes und sieht nach einem Fehler
 * aus.
 */

export interface GuardedNavItem {
  href: string;
  label: string;
  icon: string;
  badge?: number;
  exact?: boolean;
  /** Ohne Angabe für jede Rolle des Bereichs sichtbar. */
  permission?: Permission;
  /** Alternative: eine von mehreren Berechtigungen genügt. */
  anyPermission?: Permission[];
}

export interface GuardedNavGroup {
  label?: string;
  items: GuardedNavItem[];
}

export function filterNavigation(groups: GuardedNavGroup[], role: ActorRole): NavGroup[] {
  return groups
    .map((group) => ({
      label: group.label,
      items: group.items.filter((item) => {
        if (item.anyPermission?.length) return canAny(role, item.anyPermission);
        if (item.permission) return can(role, item.permission);
        return true;
      }),
    }))
    .filter((group) => group.items.length > 0) as NavGroup[];
}
