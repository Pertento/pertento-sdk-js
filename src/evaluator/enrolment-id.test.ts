import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { deriveEnrolmentId } from './enrolment-id';

const SALT = '9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a9c1f0e6b2a7d4c3e8f5a1b0d2c4e6f8a';
const V8_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deriveEnrolmentId', () => {
  test('is a lowercase version 8 UUID with the RFC variant', async () => {
    for (const customerId of ['42', 'customer@example.com', 'Kund-ÅÄÖ', '顧客']) {
      expect(await deriveEnrolmentId({ salt: SALT, customerId })).toMatch(V8_UUID);
    }
  });

  test('is the first 16 HMAC bytes with only the version and variant bits changed', async () => {
    const digest = createHmac('sha256', Buffer.from(SALT, 'utf8'))
      .update(Buffer.from('id:customer-42', 'utf8'))
      .digest();
    const bytes = Buffer.from(digest.subarray(0, 16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x80;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    expect(await deriveEnrolmentId({ salt: SALT, customerId: 'customer-42' })).toBe(expected);
  });

  test('is stable, salt-dependent and case sensitive in the customer ID', async () => {
    const id = await deriveEnrolmentId({ salt: SALT, customerId: 'Customer-42' });
    expect(await deriveEnrolmentId({ salt: SALT, customerId: 'Customer-42' })).toBe(id);
    expect(await deriveEnrolmentId({ salt: 'other', customerId: 'Customer-42' })).not.toBe(id);
    expect(await deriveEnrolmentId({ salt: SALT, customerId: 'customer-42' })).not.toBe(id);
  });
});
