import { clientReportedUserAgent, resolveClientIp } from './client-ip';

/**
 * Die technischen Angaben einer Anfrage, wie sie ins Signaturprotokoll
 * gehören: Adresse **mit Quelle** und die Browser-Angabe als das, was sie
 * ist — vom Gerät gemeldet. Eine Stelle, damit jede Route dieselbe
 * Richtlinie anwendet.
 */
export interface RequestContext {
  ip: string | null;
  ipSource: string;
  userAgent: string | null;
}

export function requestContext(request: Request): RequestContext {
  const { ip, source } = resolveClientIp(request);
  return { ip, ipSource: source, userAgent: clientReportedUserAgent(request) };
}
