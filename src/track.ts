import type { Attributes, VariantMap } from './evaluator';
import type { ErrorReporter, PertentoError, PertentoErrorKind } from './errors';
import type { FetchLike, FetchResponse } from './http';
import { isPlainObject, kindForStatus, serverMessage, thrownFetchError, timedFetch } from './http';

/** How long `track()` waits for the server before giving up. It never retries. */
export const TRACK_TIMEOUT_MS = 2_000;

/** `raw_data.event` is varchar(100) on the server. */
export const MAX_EVENT_NAME_LENGTH = 100;

/** Who converted, and anything to store with the event. Give `visitorId`, `id`, or both. */
export type TrackOptions = {
  /** The visitor ID the page was seeded with (the browser's Pertento visitor ID). */
  visitorId?: string;
  /** Your own customer ID, for experiments that assign on customer ID. Case-sensitive, used exactly as given. */
  id?: string;
  /** The same attributes you pass to `getVariant`, so targeting attributes the conversion to the same arms. */
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
  options: TrackOptions;
  timeoutMs?: number;
};

const presentString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** The `POST /sdk/events` body. Absent fields stay absent: the server refuses unknown ones, not missing ones. */
export function trackBody(event: string, { visitorId, id, attributes, data }: TrackOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { events: [data === undefined ? { name: event } : { name: event, data }] };
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
 * One conversion to `POST /sdk/events`. The server works out which arms the person is in, so
 * the SDK needs no config to track. At most once: one attempt, a 2 s timeout, no retry, because
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
  if (!presentString(options.visitorId) && !presentString(options.id)) {
    return fail('bad-request', 'track() needs a visitorId or an id: the conversion is attributed from it');
  }

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
