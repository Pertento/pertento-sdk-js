import { hmacSha256 } from './hmac';
import { formatUuid } from './uuid';

export type DeriveEnrolmentIdParams = { salt: string; customerId: string };

/**
 * The UUID a customer-ID experiment enrols under, so `visitor_enrolments` never holds the
 * customer's own ID. The first 16 bytes of HMAC-SHA256(salt, "id:" + customerId), with
 * the version nibble set to 8 and the variant bits to 10 (an RFC 9562 version 8 UUID).
 *
 * The customer ID is opaque and used exactly as given (case-sensitive, no normalisation).
 * A customer-ID experiment buckets on this derived UUID, not on the raw ID, so one
 * customer ID is one enrolment ID and one bucket. See spec/SPEC.md.
 */
export async function deriveEnrolmentId({ salt, customerId }: DeriveEnrolmentIdParams): Promise<string> {
  const digest = await hmacSha256(salt, `id:${customerId}`);
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80; // version 8
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 9562 variant
  return formatUuid(bytes);
}
