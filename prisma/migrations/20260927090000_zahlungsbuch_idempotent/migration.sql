-- Zahlungsbuch idempotent (2026-09-27) — additiv.
--
-- 1. `provider_webhook_events`: jedes verarbeitete Anbieterereignis, eindeutig
--    je (Anbieter, Ereigniskennung). Die Zeile entsteht in der Transaktion der
--    Wirkung; eine zweite Zustellung trifft den eindeutigen Index und bucht
--    nichts. Begründung am Modell in `schema.prisma`.
-- 2. `payments.refundSyncedAt`: Anbieterzeitpunkt des Erstattungsstands in
--    `refundedAmount`. Ein verspätet zugestelltes, älteres Ereignis dreht den
--    Stand damit nicht zurück.
-- 3. Datenkorrektur: Fehlgeschlagene Stripe-Versuche trugen die Kennung des
--    PaymentIntent in `providerPaymentId` — dieselbe Kennung, unter der ein
--    späterer erfolgreicher Versuch gebucht wird. Die eindeutige Spalte liess
--    die Buchung dann als „schon vorhanden" ausfallen. Die Kennung wandert in
--    `reference` (dort bleibt sie nachvollziehbar), `providerPaymentId` wird
--    frei. Der Unveränderlichkeitstrigger lässt das zu: Er schützt nur
--    eingegangene, erstattete und stornierte Zahlungen, nicht FAILED.

CREATE TABLE "provider_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_webhook_events_provider_eventId_key" ON "provider_webhook_events"("provider", "eventId");

ALTER TABLE "payments" ADD COLUMN "refundSyncedAt" TIMESTAMPTZ(6);

UPDATE "payments"
   SET "reference" = COALESCE("reference", "providerPaymentId"),
       "providerPaymentId" = NULL
 WHERE "status" = 'FAILED'
   AND "provider" = 'stripe'
   AND "providerPaymentId" IS NOT NULL;
