/** Gemeinsame Typen des Buchungsassistenten (Client und Server). */

export interface BookingService {
  id: string;
  slug: string;
  name: string;
  shortDesc: string;
  kind: string;
  icon: string;
  pricingModel: 'PER_HOUR' | 'PER_SQM' | 'FLAT' | 'PER_UNIT' | 'ON_REQUEST';
  hourlyRate: number | null;
  pricePerSqm: number | null;
  basePrice: number;
  minPrice: number;
  minHours: number;
  includes: string[];
  extras: BookingExtraOption[];
}

export interface BookingExtraOption {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string;
  price: number;
  durationMin: number;
}

export interface PriceLineDto {
  key: string;
  label: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  amount: number;
  kind: 'base' | 'extra' | 'surcharge' | 'discount' | 'travel';
}

export interface PriceBreakdownDto {
  service: { id: string; name: string; kind: string; pricingModel: string };
  lines: PriceLineDto[];
  durationMinutes: number;
  crewSize: number;
  laborHours: number;
  subtotal: number;
  extrasTotal: number;
  travelFee: number;
  surchargeTotal: number;
  discountTotal: number;
  netTotal: number;
  vatRate: number;
  vatAmount: number;
  grossTotal: number;
  currency: string;
  onRequest: boolean;
  notes: string[];
}

export interface TimeSlotDto {
  start: string;
  end: string;
  label: string;
  available: boolean;
  capacity: number;
}

export interface AvailabilityDto {
  date: string;
  closed: boolean;
  reason?: string;
  slots: TimeSlotDto[];
}

export interface SavedAddressDto {
  id: string;
  label: string | null;
  street: string;
  streetNo: string | null;
  postalCode: string;
  city: string;
  isDefault: boolean;
}

export interface SavedPropertyDto {
  id: string;
  label: string;
  kind: string;
  squareMeters: number | null;
  rooms: number | null;
  bathrooms: number | null;
  windows: number | null;
  addressId: string | null;
}
