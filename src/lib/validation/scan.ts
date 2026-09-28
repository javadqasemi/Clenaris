import { z } from 'zod';

import { SCAN_MAX_LAENGE } from '@/lib/scan/kennung';

/**
 * Scanplattform (2026-09-26).
 *
 * Der gescannte Text kommt im Rumpf eines POST, nicht in der Abfragezeile:
 * Eine QR-Rechnung ist mehrzeilig und bis zu 997 Zeichen lang, und was in
 * einer Adresse steht, landet in Zugriffsprotokollen von Proxys und Servern.
 * Ein gescannter Etikettcode ist zwar kein Geheimnis im engen Sinn, aber er
 * ist ein Schlüssel zu einem Datensatz — er gehört nicht in ein Log.
 *
 * Die Obergrenze hier ist dieselbe wie in `scanEinordnen`; was darüber liegt,
 * scheitert schon an der Validierung (422) und erreicht keinen Dienst.
 */
export const scanResolveSchema = z.object({
  text: z.string().min(1, 'Nichts gescannt.').max(SCAN_MAX_LAENGE, `Höchstens ${SCAN_MAX_LAENGE} Zeichen.`),
});

export const SCAN_ENTITIES = ['MATERIAL', 'EQUIPMENT', 'PROPERTY', 'JOB'] as const;

export const scanCodeCreateSchema = z.object({
  entityType: z.enum(SCAN_ENTITIES),
  entityId: z.string().min(1).max(40),
});

export type ScanResolveInput = z.infer<typeof scanResolveSchema>;
export type ScanCodeCreateInput = z.infer<typeof scanCodeCreateSchema>;
