import type { Attributes, VariantMap } from './evaluator';
import type { ErrorReporter, PertentoError, PertentoErrorKind } from './errors';
import type { FetchLike, FetchResponse } from './http';
import { isUuid } from './evaluator';
import { isPlainObject, kindForStatus, serverMessage, thrownFetchError, timedFetch } from './http';

/** How long `track()` waits for the server before giving up. It never retries. */
export const TRACK_TIMEOUT_MS = 2_000;

/** The longest event name the server stores. */
export const MAX_EVENT_NAME_LENGTH = 100;

/** The server's limits on who an event is for, checked here so a bad call fails before it is sent. */
export const MAX_ID_LENGTH = 256;
export const MAX_ATTRIBUTES = 50;
export const MAX_ATTRIBUTE_ARRAY_LENGTH = 100;
export const MAX_ATTRIBUTES_BYTES = 4 * 1024;

/** The most flag keys one `track()` call may name. */
export const MAX_TRACK_KEYS = 50;

/** A flag key as the dashboard allows it: lowercase letters, digits and hyphens, at most 64 characters. */
export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Who converted, which flags they were decided on, and anything to store with the event.
 * `keys` is required; give `visitorId`, `id`, or both.
 */
export type TrackOptions = {
  /**
   * The flag keys this person was decided on: the keys you passed to `getVariant` or `getAll`
   * for them. 1 to 50 keys. The conversion is credited only to those experiments, and only
   * where the person is enrolled, so it never counts in an experiment they never saw.
   */
  keys: readonly string[];
  /** The visitor ID the page was seeded with (the browser's Pertento visitor ID). */
  visitorId?: string;
  /** Your own customer ID, for experiments that assign on customer ID. Case-sensitive, used exactly as given. */
  id?: string;
  /**
   * The same attributes you passed to `getVariant` or `getAll` for this person. The server
   * re-evaluates targeting, so leaving them out (or sending different ones) drops an experiment
   * with attribute rules from the attribution although the person was enrolled in it.
   */
  attributes?: Attributes;
  /** Stored with the event, for example `{ revenue: 4900, currency: 'SEK' }`. At most 8 KB as JSON. */
  data?: Record<string, unknown>;
};

/** `ok: true` once the server accepted the event; the map is the experiments it was attributed to. */
export type TrackResult = { ok: true; experimentVariantMap: VariantMap } | { ok: false; error: PertentoError };

type SendTrackParams = {
  baseUrl: string;
  serverKey: string;
  fetch: FetchLike;
  errors: ErrorReporter;
  event: string;
  /** Typed as required, but a JavaScript caller can leave it out; that is refused like missing keys. */
  options: TrackOptions | undefined;
  timeoutMs?: number;
};

const presentString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Why `keys` would be refused by the server, or `undefined` when it is valid. */
export function invalidKeysReason(keys: unknown): string | undefined {
  if (!Array.isArray(keys)) return 'track() needs keys: the flag keys this person was decided on';
  if (keys.length === 0 || keys.length > MAX_TRACK_KEYS) return `track() needs 1 to ${MAX_TRACK_KEYS} keys`;
  if (!keys.every((key) => typeof key === 'string' && FLAG_KEY_PATTERN.test(key))) {
    return 'track() keys must be flag keys: lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters';
  }
  return undefined;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

type IdentityFields = Pick<TrackOptions, 'visitorId' | 'id' | 'attributes'>;

/**
 * Why the server would refuse who this event is for, or `undefined` when it would not: a
 * `visitorId` that is not a UUID, an `id` over 256 characters, or attributes over 50 entries,
 * 100 items in a list, or 4 KB as JSON.
 */
export function invalidIdentityReason({ visitorId, id, attributes }: IdentityFields): string | undefined {
  if (visitorId !== undefined && !isUuid(visitorId)) {
    return 'track() visitorId must be a Pertento visitor ID (a UUID), as createVisitorId() makes and the page seed carries';
  }
  if (id !== undefined && (typeof id !== 'string' || id.length > MAX_ID_LENGTH)) {
    return `track() id must be a string of at most ${MAX_ID_LENGTH} characters`;
  }
  if (attributes === undefined) return undefined;
  if (!isPlainObject(attributes)) return 'track() attributes must be an object';
  const entries = Object.entries(attributes);
  if (entries.length > MAX_ATTRIBUTES) return `track() attributes may have at most ${MAX_ATTRIBUTES} entries`;
  for (const [name, value] of entries) {
    if (Array.isArray(value) && value.length > MAX_ATTRIBUTE_ARRAY_LENGTH) {
      return `track() attributes.${name} may have at most ${MAX_ATTRIBUTE_ARRAY_LENGTH} items`;
    }
  }
  if (utf8Bytes(JSON.stringify(attributes)) > MAX_ATTRIBUTES_BYTES) {
    return `track() attributes may be at most ${MAX_ATTRIBUTES_BYTES} bytes as JSON`;
  }
  return undefined;
}

/** The `POST /sdk/events` body. Absent fields stay absent: the server refuses unknown ones, not missing ones. */
export function trackBody(event: string, { keys, visitorId, id, attributes, data }: TrackOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    events: [data === undefined ? { name: event } : { name: event, data }],
    keys: [...keys],
  };
  if (visitorId !== undefined) body['visitorId'] = visitorId;
  if (id !== undefined) body['id'] = id;
  if (attributes !== undefined) body['attributes'] = attributes;
  return body;
}

const readVariantMap = async (response: FetchResponse): Promise<VariantMap> => {
  try {
    const body = await response.json();
    const map = isPlainObject(body) ? body['experimentVariantMap'] : undefined;
    return isPlainObject(map) ? (map as VariantMap) : {};
  } catch {
    return {};
  }
};

/**
 * One conversion to `POST /sdk/events`. The server re-decides `keys` for this person and credits
 * the conversion to the ones they are enrolled in, so the SDK needs no config to track. At most once: one attempt, a 2 s timeout, no retry, because
 * a retried purchase that the server had already stored would be counted twice. Never throws;
 * a failure resolves to `{ ok: false }` and is recorded in `lastError`.
 */
export async function sendTrack({
  baseUrl,
  serverKey,
  fetch,
  errors,
  event,
  options,
  timeoutMs = TRACK_TIMEOUT_MS,
}: SendTrackParams): Promise<TrackResult> {
  const fail = (kind: PertentoErrorKind, message: string, status?: number): TrackResult => ({
    ok: false,
    error: errors.report(
      status === undefined ? { source: 'track', kind, message } : { source: 'track', kind, message, status },
    ),
  });

  if (!presentString(event) || event.length > MAX_EVENT_NAME_LENGTH) {
    return fail('bad-request', `The event name must be a string of 1 to ${MAX_EVENT_NAME_LENGTH} characters`);
  }
  const keysProblem = invalidKeysReason(options?.keys);
  if (options === undefined || keysProblem !== undefined) {
    return fail('bad-request', keysProblem ?? 'track() needs keys: the flag keys this person was decided on');
  }
  if (!presentString(options.visitorId) && !presentString(options.id)) {
    return fail('bad-request', 'track() needs a visitorId or an id: the conversion is attributed from it');
  }
  const identityProblem = invalidIdentityReason(options);
  if (identityProblem !== undefined) return fail('bad-request', identityProblem);

  let response: FetchResponse;
  try {
    response = await timedFetch({
      fetch,
      url: `${baseUrl}/sdk/events`,
      init: {
        method: 'POST',
        headers: {
          authorization: `Bearer ${serverKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(trackBody(event, options)),
      },
      timeoutMs,
    });
  } catch (error) {
    const { kind, message } = thrownFetchError(error, timeoutMs);
    return fail(kind, `Could not send "${event}" (not retried): ${message}`);
  }

  if (response.status === 200) {
    errors.clear('track');
    return { ok: true, experimentVariantMap: await readVariantMap(response) };
  }
  const message = await serverMessage(response);
  return fail(kindForStatus(response.status), `"${event}" was refused: ${message}`, response.status);
}
