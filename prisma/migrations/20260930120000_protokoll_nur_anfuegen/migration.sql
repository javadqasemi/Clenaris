-- Produktion V2 (2026-09-30): Das Prüfprotokoll (`audit_logs`) lässt sich nur
-- noch fortschreiben.
--
-- ===========================================================================
--  Warum in der Datenbank und nicht in der Anwendung
-- ===========================================================================
--
-- Das Prüfprotokoll ist der Beleg dafür, wer wann was getan hat — auch dafür,
-- dass eine Rechnung storniert, ein Lohn geändert oder eine Rolle vergeben
-- wurde. Bis hierher war es nur so unveränderlich wie der Code, der es
-- schreibt: Die Anwendung ändert und löscht keine Zeile (durchgesehen
-- 2026-09-30, jeder Zugriff auf `auditLog` und `audit_logs` in `src/`,
-- `scripts/`, `prisma/`, `tests/`; geändert haben nur das Schwärzungsskript
-- und drei Prüfdateien beim Aufräumen — beide Wege sind unten geregelt), aber
-- die Datenbank hätte jedes `UPDATE`, `DELETE` und `TRUNCATE` angenommen.
-- Ein Fehler in einem künftigen Dienst, ein Wartungsskript mit zu breitem
-- `where`, eine eingeschleuste Anweisung über eine Lücke in einer rohen
-- Abfrage — jeder davon könnte die Spur einer Handlung verwischen, und nichts
-- im Bestand verriete es. Ein Protokoll, das sein Gegenstand ändern kann,
-- beweist nichts.
--
-- Dieselbe Regel gilt schon für die Signaturereignisse
-- (`20260920100000_signatur_kern`, `signature_events_kein_*`) und die
-- Lagerbewegungen (`20260923180000_betrieb_reklamation_material_geraete`,
-- `stock_movements_nur_anfuegen`): Was ein Verlauf ist, wird angefügt, nie
-- umgeschrieben. Eine Prüfung allein im Dienst wäre die schwächere Wahl —
-- sie schützt nur die Wege, die durch diesen Dienst führen, und jede neue
-- Stelle müsste sie kennen.
--
-- ===========================================================================
--  Die drei Ausnahmen — jede mit ihrem Grund
-- ===========================================================================
--
--  1. **Kaskade beim Löschen einer ganzen Organisation.** `audit_logs` hängt
--     mit `ON DELETE CASCADE` an `organizations`. Das Löschen eines Mandanten
--     muss möglich bleiben (Wegwerf-Organisationen der Prüfreihe, eine
--     Kündigung samt Löschpflicht). Erlaubt ist das Löschen deshalb nur
--     verschachtelt (`pg_trigger_depth() > 1`, also aus der
--     Fremdschlüsselaktion heraus) **und** nur, wenn die Organisation der
--     Zeile tatsächlich nicht mehr besteht. Die zweite Bedingung ist die
--     schärfere: `pg_trigger_depth() > 1` allein liesse auch einen künftigen,
--     fehlerhaften Trigger auf einer anderen Tabelle Protokollzeilen löschen.
--     So bleibt es beim einen Weg, auf dem mit der Organisation ohnehin alles
--     verschwindet.
--
--  2. **Ein gelöschtes Konto löst nur den Verweis.** `audit_logs.userId`
--     hängt mit `ON DELETE SET NULL` an `users`. Diese Aktion ist ein
--     `UPDATE` auf `audit_logs` und muss durchgehen — sonst liesse sich kein
--     Konto mehr löschen, das je etwas getan hat (Datenbereinigung,
--     Aufräumen der Prüfreihe). Erlaubt ist genau diese Änderung und keine
--     andere: verschachtelt, `userId` von einem Wert auf NULL, das Konto
--     tatsächlich weg, **jede andere Spalte unverändert** (Vergleich der
--     ganzen Zeile ohne `userId` über `to_jsonb`, damit eine künftige Spalte
--     automatisch mitgeschützt ist, statt in einer Aufzählung zu fehlen). Der
--     Eintrag selbst bleibt stehen: Was geschah, bleibt belegt, nur die
--     Person dahinter ist nicht mehr auflösbar.
--
--     `ON UPDATE CASCADE` an beiden Fremdschlüsseln bleibt dagegen gesperrt:
--     Kennungen ändern sich in Clenaris nie (`cuid()`), und ein Umschlüsseln,
--     das Protokollzeilen einer anderen Person oder Organisation zuschlüge,
--     soll laut scheitern statt still durchlaufen.
--
--  3. **Schwärzung mit ausdrücklichem Schalter.** `scripts/audit-bereinigung.ts`
--     schwärzt Altbestand, der vor RB-010 Personendaten im Klartext trug
--     (Datenschutz geht hier der Unveränderlichkeit vor, und die Bereinigung
--     protokolliert sich selbst). Sie setzt dafür in ihrer Transaktion
--     `set_config('clenaris.audit_schwaerzung', 'on', true)` — über
--     `scripts/security/audit-schwaerzung.ts`, den einzigen Ort, der das tut.
--     Auch dann dürfen sich nur `changes` und `summary` ändern; wer, wann,
--     welche Entität und welche Handlung bleiben unantastbar, und Löschen
--     bleibt verboten. Vorbild ist `clenaris.bereinigung` aus
--     `20260923201000_finanzen_bereinigung_freigabe`: gilt nur bis zum Ende
--     der Transaktion, muss ausdrücklich geschrieben werden, und
--     `session_replication_role` als Alternative verlangte eine
--     Superuser-Rolle, die die Anwendung in der Produktion nicht hat.
--
-- Die Testdatenbank räumt ihren Prüfbestand weiterhin über
-- `schutzfreiAufraeumen` (`tests/helpers/testdb.ts`,
-- `session_replication_role = 'replica'`) — nur dort, nie in der Anwendung.
--
-- ===========================================================================
--  Was der Trigger nicht leistet
-- ===========================================================================
--
-- Wer die Datenbankrolle der Anwendung **selbst** hat, hält ihn nicht auf. In
-- der heutigen Auslieferung spielt dieselbe Rolle die Migrationen ein
-- (`prisma migrate deploy` mit `DATABASE_URL`) und besitzt damit die
-- Tabellen; sie kann den Trigger mit `ALTER TABLE … DISABLE TRIGGER`
-- abschalten, ihn löschen oder den Schwärzungsschalter aus Ausnahme 3
-- setzen. Gegen den Eigentümer einer Tabelle schützt keine Regel in derselben
-- Datenbank — der Schalter ist eine ausdrückliche Absicht, keine
-- Berechtigung. Was bleibt, ist das Erkennen:
-- `scripts/datenbank-schranken.ts` (Tor nach jeder Migration, im CI und im
-- Prüfweg) und `scripts/datenbank-vertrauenspruefung.ts` lesen
-- `pg_trigger.tgenabled` und melden einen fehlenden oder abgeschalteten
-- Trigger. Abgeschaltet, missbraucht und wieder eingeschaltet hinterlässt er
-- in den Katalogen keine Spur; das zu belegen braucht ein Protokoll ausserhalb
-- dieser Datenbank (Serverprotokoll mit `log_statement = 'ddl'`, aufbewahrte
-- Sicherungen) und eine eigene Eigentümerrolle für die Migrationen, getrennt
-- von der Rolle, mit der die Anwendung läuft. Beides ist ein Betriebsentscheid
-- und steht nicht in diesem Repository.
--
-- ===========================================================================
--  Fehlercode
-- ===========================================================================
--
-- `P0001` (raise_exception), wie alle Schutztrigger dieses Schemas. Der
-- Treiberadapter von Prisma 7 reicht nur diesen Code samt Meldung durch;
-- `restrict_violation` machte er zu „Fremdschlüssel verletzt" und verwarf die
-- Meldung (`20260929090000_vertragssperre_fehlercode`). Gemessen gegen eine
-- frische Testdatenbank: Eine Modellabfrage scheitert als P2039, eine rohe
-- als P2010, beide mit `originalCode` P0001 und dieser Meldung unter
-- `meta.driverAdapterError.cause`.
--
-- Bewusst **keine** allgemeine HTTP-Abbildung von P0001 in `toErrorResponse`
-- (`src/lib/api/response.ts`): Feuert ein Schutztrigger, hat das Programm
-- etwas Verbotenes versucht — das ist ein Programmfehler, kein Zustand, den
-- eine Person durch eine andere Eingabe beheben könnte. Die Antwort ist
-- deshalb ein 500 mit Eintrag im Serverprotokoll („Unbehandelter Fehler");
-- ein 422 legte nahe, ein zweiter Versuch mit anderen Daten könne gelingen,
-- und verdeckte den Fehler im Code.
--
-- Keine Tabelle, keine Spalte, keine Daten: Die vorherige Programmfassung
-- legt Protokollzeilen nur an und läuft unverändert weiter
-- (`security/migrations-vertraeglichkeit.json`).

CREATE OR REPLACE FUNCTION audit_logs_nur_anfuegen() RETURNS trigger AS $$
BEGIN
  -- TRUNCATE zuerst: Ein Trigger je Anweisung kennt weder OLD noch NEW, und
  -- das Leeren der ganzen Tabelle hat keine Ausnahme.
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Das Prüfprotokoll lässt sich nur fortschreiben — es wird nie geleert (TRUNCATE verweigert).'
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'DELETE' THEN
    -- Ausnahme 1: die Kaskade einer gelöschten Organisation.
    IF pg_trigger_depth() > 1
       AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o."id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Das Prüfprotokoll lässt sich nur fortschreiben — Eintrag % wird nicht gelöscht (DELETE verweigert).', OLD."id"
      USING ERRCODE = 'P0001';
  END IF;

  -- Ausnahme 2: ON DELETE SET NULL eines gelöschten Kontos.
  IF pg_trigger_depth() > 1
     AND OLD."userId" IS NOT NULL
     AND NEW."userId" IS NULL
     AND (to_jsonb(NEW) - 'userId') = (to_jsonb(OLD) - 'userId')
     AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = OLD."userId") THEN
    RETURN NEW;
  END IF;

  -- Ausnahme 3: Schwärzung mit ausdrücklichem Schalter, nur der Inhalt.
  IF coalesce(current_setting('clenaris.audit_schwaerzung', true), '') = 'on'
     AND (to_jsonb(NEW) - ARRAY['changes', 'summary']) = (to_jsonb(OLD) - ARRAY['changes', 'summary']) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Das Prüfprotokoll lässt sich nur fortschreiben — Eintrag % wird nicht geändert (UPDATE verweigert).', OLD."id"
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_nur_anfuegen
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_nur_anfuegen();

CREATE TRIGGER audit_logs_kein_leeren
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_nur_anfuegen();
