import { BUCKET_COUNT } from './constants';
import { hmacSha256 } from './hmac';

export type BucketForParams = { salt: string; experimentId: number; id: string };

/**
 * The visitor's bucket in [0, 10000) for one experiment:
 * uint32_be(HMAC-SHA256(salt, experimentId + ":" + id.toLowerCase())[0..4]) % 10000.
 *
 * The experiment ID is in the message so one person lands independently in each
 * experiment; the ID is lowercased so a UUID's casing never moves anyone.
 */
export async function bucketFor({ salt, experimentId, id }: BucketForParams): Promise<number> {
  const digest = await hmacSha256(salt, `${experimentId}:${id.toLowerCase()}`);
  return readUint32BE(digest) % BUCKET_COUNT;
}

const readUint32BE = (bytes: Uint8Array): number =>
  ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
