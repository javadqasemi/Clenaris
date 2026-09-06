import 'server-only';

import { cache } from '@/lib/redis';
import { IntegrationError } from '@/lib/errors';

/**
 * Google-Maps-Anbindung (Server-Seite).
 *
 * Architekturentscheid: Geocoding und Distanzmatrix laufen ausschliesslich über
 * den Server-Key und werden 30 Tage gecacht. Adressen ändern sich praktisch nie,
 * und Google berechnet jede Anfrage einzeln — der Cache senkt die Kosten um
 * Grössenordnungen. Der Browser-Key ist auf die Domain beschränkt und wird nur
 * für die Karten-Darstellung und Autocomplete verwendet.
 */

const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const DISTANCE_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';

function serverKey(): string {
  const key = process.env.GOOGLE_MAPS_SERVER_KEY ?? process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!key) throw new IntegrationError('Google Maps', 'Kein API-Key konfiguriert.');
  return key;
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
  postalCode: string | null;
  city: string | null;
  canton: string | null;
  country: string | null;
  placeId: string;
}

export async function geocodeAddress(address: string): Promise<GeocodeResult | null> {
  const normalized = address.trim().toLowerCase();
  const cacheKey = `geo:${Buffer.from(normalized).toString('base64url').slice(0, 100)}`;

  return cache.remember<GeocodeResult | null>(cacheKey, 60 * 60 * 24 * 30, async () => {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('address', address);
    url.searchParams.set('key', serverKey());
    url.searchParams.set('region', 'ch');
    url.searchParams.set('language', 'de');
    url.searchParams.set('components', 'country:CH');

    const response = await fetch(url, { next: { revalidate: 0 } });
    if (!response.ok) {
      throw new IntegrationError('Google Maps', `Geocoding fehlgeschlagen (${response.status}).`);
    }

    const data = (await response.json()) as {
      status: string;
      results: {
        geometry: { location: { lat: number; lng: number } };
        formatted_address: string;
        place_id: string;
        address_components: { long_name: string; short_name: string; types: string[] }[];
      }[];
    };

    if (data.status === 'ZERO_RESULTS' || !data.results.length) return null;
    if (data.status !== 'OK') {
      throw new IntegrationError('Google Maps', `Geocoding-Status ${data.status}.`);
    }

    const result = data.results[0];
    const component = (type: string) =>
      result.address_components.find((c) => c.types.includes(type));

    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formattedAddress: result.formatted_address,
      postalCode: component('postal_code')?.long_name ?? null,
      city: component('locality')?.long_name ?? component('postal_town')?.long_name ?? null,
      canton: component('administrative_area_level_1')?.short_name ?? null,
      country: component('country')?.short_name ?? null,
      placeId: result.place_id,
    };
  });
}

export interface TravelInfo {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
}

export async function getTravelInfo(
  origin: string | { lat: number; lng: number },
  destination: string | { lat: number; lng: number },
): Promise<TravelInfo | null> {
  const originStr = typeof origin === 'string' ? origin : `${origin.lat},${origin.lng}`;
  const destStr =
    typeof destination === 'string' ? destination : `${destination.lat},${destination.lng}`;

  const cacheKey = `travel:${Buffer.from(`${originStr}|${destStr}`).toString('base64url').slice(0, 100)}`;

  return cache.remember<TravelInfo | null>(cacheKey, 60 * 60 * 24 * 7, async () => {
    const url = new URL(DISTANCE_URL);
    url.searchParams.set('origins', originStr);
    url.searchParams.set('destinations', destStr);
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('language', 'de');
    url.searchParams.set('region', 'ch');
    url.searchParams.set('key', serverKey());

    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as {
      status: string;
      rows: {
        elements: {
          status: string;
          distance?: { value: number; text: string };
          duration?: { value: number; text: string };
        }[];
      }[];
    };

    const element = data.rows?.[0]?.elements?.[0];
    if (data.status !== 'OK' || !element || element.status !== 'OK') return null;

    return {
      distanceMeters: element.distance!.value,
      durationSeconds: element.duration!.value,
      distanceText: element.distance!.text,
      durationText: element.duration!.text,
    };
  });
}

/**
 * Luftlinie in Metern (Haversine).
 * Wird für die GPS-Plausibilitätsprüfung beim Ein-/Ausstempeln verwendet —
 * dafür ist keine API-Anfrage nötig.
 */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** Navigations-Link für die App der Mitarbeitenden. */
export function navigationUrl(destination: string | { lat: number; lng: number }): string {
  const dest =
    typeof destination === 'string'
      ? encodeURIComponent(destination)
      : `${destination.lat},${destination.lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

/** Statisches Kartenbild (z. B. in PDFs oder E-Mails). */
export function staticMapUrl(params: {
  center: { lat: number; lng: number };
  zoom?: number;
  width?: number;
  height?: number;
}): string {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const { center, zoom = 15, width = 640, height = 320 } = params;
  return (
    `https://maps.googleapis.com/maps/api/staticmap?center=${center.lat},${center.lng}` +
    `&zoom=${zoom}&size=${width}x${height}&scale=2&maptype=roadmap` +
    `&markers=color:0x0B7285%7C${center.lat},${center.lng}&key=${key}`
  );
}
