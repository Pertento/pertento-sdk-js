# @pertentoai/sdk

The Pertento server-side SDK for JavaScript and TypeScript. Decide which variant a visitor
sees on your server, hand that decision to the page, and report conversions from your
backend. Runs on Node 20+, Bun, Deno and edge workers (Cloudflare Workers, Vercel Edge,
Deno Deploy). It uses only `fetch` and Web Crypto and has no dependencies. It is an ES module
package: use `import`, not `require` (on Node versions that cannot `require` ES modules).

In the Pertento dashboard these are **Server-side** experiments with **Assignment: Server**:
your code renders each variant, and Pertento decides who gets which.

```sh
npm install @pertentoai/sdk
# or: bun add @pertentoai/sdk / pnpm add @pertentoai/sdk / deno add npm:@pertentoai/sdk
```

## Requirements

- **Visitor ID turned on for the website** (Websites, settings, Visitor ID). The page and your
  server have to agree on who the visitor is; without it the browser cannot adopt the visitor ID
  your server decided for.
- **A server key** (`psk_live_...`) from the dashboard (Websites, the key button on the website's
  row). It is shown once, and it is a secret:
  keep it in an environment variable on your server and never send it to a browser.
- **Tracking method "Server-side"** (Websites, settings), only if you want to report conversions from your backend
  with `track()`. See [Reporting conversions](#reporting-conversions-from-your-backend).

## Quick start

Create one client per process and share it. It loads the website's config and keeps it fresh
in the background, so `getVariant` is decided locally with no network call. What it decided is
reported to Pertento afterwards, in batches (see [Exposures](#exposures)).

```ts
import { createPertento } from '@pertentoai/sdk';

const pertento = createPertento({
  websiteId: Number(process.env.PERTENTO_WEBSITE_ID),
  serverKey: process.env.PERTENTO_SERVER_KEY!,
});

await pertento.ready(); // optional: waits up to 5 s for the first config; never throws
```

`ready()` resolves `true` once the config is loaded and `false` if it is not loaded in time. It
never rejects, so a slow network or a refused key at startup cannot stop your server: decisions
fall back to control until the config arrives, and `pertento.lastError` says why.

> **Required: persist the visitor ID and send it back.** Pertento sets no cookies, so your
> server has to remember who the visitor is. Store the visitor ID the first time you mint it
> (in your session, or a first-party cookie you set) and pass the same ID on every later request
> for that person. A request without it is a new visitor: they are bucketed afresh on every page
> and their conversions land on unrelated variants. See
> [Carrying the visitor ID](#carrying-the-visitor-id).

On each request:

```ts
// 1. Who is this? Reuse the visitor ID you stored for them, or mint one on their first request.
let visitorId = session.pertentoVisitorId ?? request.headers.get('x-pertento-visitor-id');
if (!visitorId) {
  visitorId = pertento.createVisitorId();
  session.pertentoVisitorId = visitorId;
}

// 2. Decide.
const checkout = await pertento.getVariant('new-checkout', { visitorId, attributes: { plan: user.plan } });
if (checkout.variantKey === 'one-page') {
  // render the one-page checkout; checkout.payload holds the variant's JSON payload
}

// 3. Tell the page what was decided, in <head>, before the Pertento snippet.
const head = pertento.seedScript([checkout], visitorId);
```

The page then carries:

```html
<head>
  <script>window.PertentoSeed={"visitorId":"…","assignments":{"501":{"variantId":"9002"}}};</script>
  <script src="https://scripts.pertento.ai/…"></script> <!-- your Pertento snippet -->
</head>
```

The snippet reads `window.PertentoSeed`, adopts the visitor ID, enrols the visitor in exactly
the variants your server chose, and counts them. **The seed must come before the snippet**; a
seed written after it is not seen. Because the page reports these decisions, the client does
not report them as well.

### Carrying the visitor ID

Pertento sets **no cookies**. Where you keep the visitor ID between requests is up to you:

- **Your own session** (a session store, or a first-party cookie you set yourself). Mint an ID
  with `createVisitorId()` on the first request, store it, and pass the same ID on every request
  after that.
- **A header from your own frontend.** The snippet exposes the browser's ID as
  `window.Pertento.visitorId`; a single-page app can send it on its API calls, for example as
  `x-pertento-visitor-id`, and your server passes it to `getVariant`. A header is client input:
  a value that is not a Pertento visitor ID (a UUID) is ignored, and the decision says `no-id`,
  so mint a new ID for that visitor rather than passing it on.

Once the page has been seeded, the browser keeps the seeded visitor ID. A returning visitor
whose server session is new gets a new visitor ID and counts as a new visitor.

### Deciding for every experiment at once

```ts
const decisions = await pertento.getAll({ visitorId });   // { [flagKey]: Decision }
const head = pertento.seedScript(decisions, visitorId);   // a record works as well as a list
```

### What a decision looks like

```ts
type Decision =
  | { enrolled: true;  experimentId: number; variantId: number; variantKey: string; payload: unknown; enrolAs?: string }
  | { enrolled: false; experimentId: number | null; variantId: number | null; variantKey: string | null; payload: unknown; reason: DecisionReason };
```

A visitor who is not enrolled gets control (the variant with the lowest ID; for a feature flag,
Off), and `reason` says why:

| `reason` | Meaning |
| --- | --- |
| `unknown-key` | No experiment has this flag key, or the SDK has no config yet. Everything is `null`: render your default. |
| `not-running` | The experiment is not running. A deployed experiment returns its deployed variant. |
| `no-id` | No visitor ID or customer ID was given. |
| `wrong-id-kind` | The experiment assigns on the other kind of ID than the one you passed. |
| `targeting` | The attribute rules did not match the `attributes` you passed. |
| `ring` | Feature flags only: a ring (a fixed list of people or a rule) decided this person's side. See [Feature flags](#feature-flags). |

`getVariant` and `getAll` never reject. Before the first config arrives every key is
`unknown-key`, so a cold start or an outage shows your default experience, never an error.

## Assigning on your own customer ID

An experiment can assign on your customer ID instead of the visitor ID (chosen on the
experiment's settings tab while it is a draft). Pass it as `id`:

```ts
const pricing = await pertento.getVariant('pricing-page', { id: String(user.id), visitorId });
const head = pertento.seedScript([pricing], visitorId);
```

The same customer then gets the same variant on every device. Things to know:

- **IDs are opaque and case-sensitive.** `Cust-1` and `cust-1` are two different people. Pass
  exactly the same string every time; do not trim, lowercase or reformat it.
- **Pertento never stores your customer ID.** It derives a random-looking enrolment ID from it
  with the website's secret salt (`decision.enrolAs`), and enrols and counts that. The
  enrolment ID is still pseudonymous data, not anonymous: anyone holding the salt can compute
  it from a customer ID and link the two.
- **Use opaque customer IDs.** A server key also gives access to the website's bucketing salt
  (`GET /sdk/config` returns it), so whoever holds the key can derive the enrolment ID of any
  customer ID they can guess. Prefer IDs that are not sequential or guessable (a UUID, or a
  keyed hash of your internal ID) over `1`, `2`, `3`, and guard the key like a password.
- **Visitor counts are not comparable across ID kinds.** A customer-ID experiment counts
  customers; a visitor experiment counts browsers. Compare arms within an experiment, not totals
  between experiments of different kinds.
- Pass the ID kind the experiment expects. With only a visitor ID, a customer-ID experiment
  answers control with reason `wrong-id-kind` (and the other way round). Passing both is fine:
  each experiment uses its own kind.

## Feature flags

A feature flag is an experiment with two variants, **Off** and **On**, that is rolled out
gradually instead of split by weight. You ask for it like any other key:

```ts
const search = await pertento.getVariant('new-search', {
  visitorId,
  attributes: { plan: user.plan, staff: user.isStaff },
});
if (search.variantKey === 'on') {
  // the new code path; search.payload carries the On variant's payload, if it has one
}
```

How a flag decides, in this order:

1. **Eligibility.** When the flag has attribute rules and they do not match, the answer is Off
   with reason `targeting`.
2. **Rings.** An ordered list of people who get a fixed side whatever the rollout is: staff On, a
   beta list On, key accounts Off. A ring matches on attributes, on a list of IDs, or on both
   (visitor IDs compare in any case; customer IDs compare exactly). The first ring that matches
   decides, and the answer has `enrolled: false` and reason **`ring`**: ring members are chosen,
   not random, so they are kept out of the On/Off comparison.
3. **The rollout.** Everyone else has a fixed bucket for the flag and is On when the bucket is
   below the rollout percentage, Off otherwise, and is **enrolled either way**: the people who are
   Off are the comparison group, and `track()` credits their conversions too.

**A rollout only ever adds people.** Raising it from 10% to 25% keeps everyone who was On and adds
more; nobody goes back to Off. Someone moves from On to Off only when the rollout is lowered (or
switched off), or when they become ineligible or join an Off ring. A flag can also have a
**holdback**: a share of people who stay Off even at 100%, so there is still something to compare
against.

Flags need version 0.2.0 or later of this package. A config that contains a flag has config
version 2; an older SDK treats it as a version it does not understand, so every key answers
`unknown-key` (your default) until you upgrade. A config without flags stays version 1, which every
version reads.

## Exposures

An exposure is Pertento's record that a person was enrolled in a variant of an experiment. On a
page you seed, the snippet records it. A decision your server acts on without seeding a page (a
feature flag in your backend code, an API response, an email) has no snippet to record it, so the
client reports it: every enrolled decision `getVariant` and `getAll` return is sent to
`POST /sdk/exposures`. Exposures are what an experiment's results are counted from, and they
count toward your plan's sessions as a visit with the snippet does, so without them a flag decided
only on your server has no results and no sessions. Decisions that are not enrolled
(`enrolled: false`) are not exposures and are never sent, with the one exception below.

Decisions served from a deployed experiment are reported too. Once you deploy a variant, every
person is served it with `enrolled: false` and reason `not-running`, and the client reports that
decision so it counts toward your plan's sessions as a deployed variant on a page does. It is
not an enrolment and adds nothing to the experiment's results. The enrolment ID is the visitor ID
for a visitor experiment, and the ID derived from `id` for a customer ID experiment; a decision
without the ID its experiment assigns on is not sent. A page seed carries only enrolled
decisions, so a deployed decision is reported whether or not you seed the page.

You do not call anything to make this happen. How it works:

- **Once per person.** Each experiment and enrolment ID (`decision.enrolAs` for a customer ID
  experiment, the visitor ID otherwise) is sent once per client. The client remembers the last
  10,000 it has seen; Pertento also ignores repeats, so a person reported by two of your servers
  is still counted once.
- **Batched.** Exposures wait in a queue and are sent within 2 seconds, or at once when 100 are
  waiting. In Node the timer is unref'd and never keeps your process alive.
- **Never in the way of a decision.** `getVariant` and `getAll` return before anything is sent,
  and nothing is retried: one attempt with a 2 second timeout. A batch that fails is dropped,
  recorded in `lastError` with source `exposures`, and logged once per kind like any other
  failure.
- **Seeded pages are left to the browser.** The decisions you pass to `pertento.seedScript()` are
  taken out of the queue and never sent, because the snippet enrols them. The standalone
  `seedScript` export does not do this; use the client's method. This only saves a request:
  Pertento counts a person once whether your server or the page reports them first, so a batch
  sent before you built the seed is not counted twice.
- **Shutting down.** `await pertento.close()` sends what is queued and stops the timers.
  `await pertento.flush()` sends the queue without stopping anything; it never rejects.
- **Edge workers.** With `background: false` there is no timer: the next `getVariant`, `getAll`
  or `track` sends the queue, and you pass `pertento.flush()` to `waitUntil` so the last batch of a
  request is not cut off (see [Edge workers](#edge-workers)).
- **Limits.** Up to 100 exposures per request, and 600 requests a minute per server key, a budget
  of its own so exposures never use up the one your conversions need.

To report nothing, pass `exposures: false`. Decisions are unchanged; experiments decided only on
your server then have no results.

Exposures are reported from version 0.3.0. Earlier versions report only what the snippet sees on
seeded pages.

## Reporting conversions from your backend

```ts
const result = await pertento.track('purchase', {
  keys: ['new-checkout'],             // the flag keys you decided this person on
  visitorId,                          // or id: String(user.id), or both
  attributes: { plan: user.plan },    // the same attributes you decided with
  data: { revenue: 4900, currency: 'SEK' },
});
if (!result.ok) console.warn(result.error.kind, result.error.message);
```

`track()` posts to `POST /sdk/events`. Pertento decides `keys` again for the ID you send and
credits the conversion to the experiments among them that the person is enrolled in, so your
server needs no extra bookkeeping. The rules:

- **`keys` is required.** Pass the flag keys you passed to `getVariant` or `getAll` for this
  person (1 to 50 keys, each lowercase letters, digits and hyphens, at most 64 characters). Only
  those experiments are credited, so a conversion never counts in an experiment the person was
  never shown. Missing or invalid `keys` sends nothing: `track()` resolves `{ ok: false }` with
  kind `bad-request` and records the reason in `lastError`.
- **`attributes` must match the ones you decided with.** Targeting rules are evaluated again,
  so leaving `attributes` out, or sending different values, drops an experiment with attribute
  rules from the attribution although the person was enrolled in it.

- **One reporter per website.** `track()` works only when the website's tracking method is
  **Server-side**. In that mode the browser snippet reports nothing, so conversions are never
  counted twice. In any other mode the server answers 409 and `track()` resolves
  `{ ok: false, error: { kind: 'wrong-tracking-method' } }`.
- **Only for people who were enrolled.** A conversion counts against the visitors who loaded a
  page carrying the seed, or whose decision the client reported as an exposure. Tracking someone
  who was never enrolled adds a conversion with no matching visitor and skews the result.
- **At most once.** `track()` makes one attempt with a 2 second timeout and **never retries**,
  because a retried purchase that had in fact arrived would be counted twice. Do not wrap it in
  your own retry either. A timeout may or may not have been recorded.
- It never rejects. Check `result.ok`, or read `pertento.lastError`.

## Errors and logging

Nothing the SDK does after `createPertento` throws into your request path. Network failures, a
refused key or a config it cannot use are recorded in `pertento.lastError`
(`{ source, kind, message, status?, at }`) and logged with `console.error` **once per kind**, so
a broken key does not write a line per request. `lastError` clears when that part of the SDK
next succeeds.

| Situation | What happens |
| --- | --- |
| Config request fails (network, 5xx) | The last good config keeps being used; the next poll tries again. |
| 503 or 429, with `Retry-After` | The last good config keeps being used; the next request waits as long as `Retry-After` asks (1 second to 5 minutes), even past a poll. The tracking server answers 503 while it starts up. |
| Server key refused (401) | Retried with backoff (2 seconds, doubling to 30) for 2 minutes, since a key just created takes up to about 30 seconds to become active. Any other answer ends the run. After 2 minutes of nothing but 401s, polling stops for good and `ready()` resolves `false` at once: check the key, or create a new one and restart. The last good config, if any, keeps being used. |
| Config of a newer version than this SDK understands | Treated as no config (every key `unknown-key`). Upgrade the package. |
| Server key belongs to another website than `websiteId` | Treated as no config. Fix the settings. |
| A batch of exposures fails (network, timeout, any refusal) | The batch is dropped, not retried. Decisions are unaffected. |

`createPertento` itself throws a `TypeError` for invalid options (a missing or malformed key, a
bad website ID).

## How fresh the config is

The client polls `GET /sdk/config` every 30 seconds (`pollIntervalMs`, minimum 5000) and the
server caches each website's config for up to 15 seconds, so a change in the dashboard
(starting, stopping, or editing an experiment) reaches your servers within about 45 seconds.
Until then they decide with the previous config. Polls send `If-None-Match`, so an unchanged
config costs an empty 304. In Node the timer is unref'd and never keeps your process alive;
`pertento.close()` stops it.

## Edge workers

Request-scoped runtimes keep no timers between requests, and some forbid network calls outside
a request. Create the client at module scope with `background: false`, and await `ready()` in
the handler with a short timeout (it returns at once after the first load, and at once after a
failed one, so a Pertento outage costs a page at most that timeout). Pass `pertento.flush()` to
`waitUntil`, so the exposures a request queued are sent after the response:

```ts
import { createPertento } from '@pertentoai/sdk';

let pertento: ReturnType<typeof createPertento> | undefined;

export default {
  async fetch(
    request: Request,
    env: { PERTENTO_WEBSITE_ID: string; PERTENTO_SERVER_KEY: string },
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ) {
    pertento ??= createPertento({
      websiteId: Number(env.PERTENTO_WEBSITE_ID),
      serverKey: env.PERTENTO_SERVER_KEY,
      background: false,
    });
    await pertento.ready(1000); // false without a config: decisions fall back to control

    const visitorId = request.headers.get('x-pertento-visitor-id') ?? pertento.createVisitorId();
    const decision = await pertento.getVariant('new-checkout', { visitorId });
    const head = pertento.seedScript([decision], visitorId);
    ctx.waitUntil(pertento.flush()); // sends any exposures this request queued; never rejects
    return new Response(renderPage({ head, decision }), { headers: { 'content-type': 'text/html' } });
  },
};
```

With `background: false`, a call that finds the config older than `pollIntervalMs` answers from
the config it has and starts a refresh it does not wait for, so a later request sees the new
config. Queued exposures are sent the same way: by the next call, or by `flush()`.

## API

```ts
createPertento({
  websiteId: number,
  serverKey: string,
  baseUrl?: string,         // default https://tracking.pertento.ai
  pollIntervalMs?: number,  // default 30000, minimum 5000
  background?: boolean,     // default true; false for edge workers
  exposures?: boolean,      // default true; false reports no exposures
  fetch?: typeof fetch,     // e.g. a proxy-aware fetch, or a stub in tests
}) => {
  ready(timeoutMs = 5000): Promise<boolean>, // never rejects
  getVariant(key: string, identity?: { visitorId?, id?, attributes? }): Promise<Decision>,
  getAll(identity?): Promise<Record<string, Decision>>,
  createVisitorId(): string,
  seedScript(decisions: Decision[] | Record<string, Decision>, visitorId?: string, options?: { nonce?: string }): string,
  track(event: string, options: { keys: string[], visitorId?, id?, attributes?, data? }): Promise<TrackResult>,
  flush(): Promise<void>,   // sends queued exposures; never rejects
  readonly lastError: PertentoError | null,
  close(): Promise<void>,   // sends queued exposures and stops the timers; never rejects
}
```

`seedScript` escapes the JSON so no value can close the `<script>` element. Pass `nonce` if your
Content-Security-Policy requires one.

`attributes` is a flat object of strings, finite numbers, booleans and arrays of strings and
numbers. Types are never coerced: `"5"` does not match a rule on the number `5`.

## HTTP endpoints for other stacks

Every endpoint is on `https://tracking.pertento.ai`, authenticated with
`Authorization: Bearer psk_live_...`, and rate limited per key. Errors answer
`{ "error": "message" }` with the status (400 bad body, 401 bad key, 404 no config,
409 wrong tracking method, 429 too many requests, 503 starting up). A key just created can be
answered 401 for up to about 30 seconds; retry with backoff for a short while before treating it
as wrong. On 503 or 429, wait as long as `Retry-After` says when it is present.

### `POST /sdk/decide`

Decides on Pertento's side, for a stack without an SDK. 600 requests a minute per key.

```sh
curl https://tracking.pertento.ai/sdk/decide \
  -H "Authorization: Bearer $PERTENTO_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "keys": ["new-checkout"], "visitorId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "attributes": { "plan": "pro" } }'
```

Body: `keys` (optional, at most 50; all experiments when absent), `visitorId` (a UUID), `id`
(your customer ID, at most 256 characters), `attributes` (at most 50 entries, 4 KB). When you
send no ID at all, a new visitor ID is minted and returned with `visitorIdMinted: true`.

```json
{
  "visitorId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  "visitorIdMinted": false,
  "decisions": { "new-checkout": { "experimentId": 501, "variantId": 9002, "variantKey": "one-page", "payload": { "layout": "single" }, "enrolled": true } },
  "seed": { "visitorId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "assignments": { "501": { "variantId": "9002" } } }
}
```

**When `visitorIdMinted` is `true`, you must store the returned `visitorId`** (for example in
your own session or a first-party cookie you set) and send it back as `visitorId` on every later
`/sdk/decide` and `/sdk/events` for that person. Pertento sets no cookies and cannot see the
browser's ID from here, so a caller that does not send it back makes every request a new
visitor: each page is bucketed afresh and conversions land on unrelated variants.

Write `seed` into the page as `window.PertentoSeed`, escaping `<`, `>`, `&`, U+2028 and U+2029 as
`\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029` so it cannot close the script element.

### `POST /sdk/events`

Reports conversions; the same rules as `track()` (Server-side tracking method, at most once,
no retries). 600 requests a minute per key, a budget of its own, so a burst of decisions cannot
crowd out the conversions reported in the same minute.

```sh
curl https://tracking.pertento.ai/sdk/events \
  -H "Authorization: Bearer $PERTENTO_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "events": [{ "name": "purchase", "data": { "revenue": 4900, "currency": "SEK" } }], "keys": ["new-checkout"], "visitorId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "attributes": { "plan": "pro" } }'
```

Body: `events` (1 to 20, each `{ name, data? }`, name at most 100 characters, data at most
8 KB), `keys` (required, 1 to 50 flag keys matching `^[a-z0-9][a-z0-9-]{0,63}$`: the keys this
person was decided on), and `visitorId`, `id` or both (one is required), plus optional
`attributes`, which must be the ones sent to `/sdk/decide`. Unknown fields are refused with 400.
Answers `{ "ok": true, "experimentVariantMap": { "501": "9002" } }`: the experiments among
`keys` that the person is enrolled in, which is what the events were attributed to.

### `POST /sdk/exposures`

Reports enrolled and deployed decisions made on your side, as the client does in the background (see
[Exposures](#exposures)). Rate limited per key with a budget of its own.

```sh
curl https://tracking.pertento.ai/sdk/exposures \
  -H "Authorization: Bearer $PERTENTO_SERVER_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "exposures": [{ "experimentId": 501, "variantId": 9002, "enrolAs": "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }] }'
```

Body: `exposures`, 1 to 100 items, each the `experimentId` and `variantId` of an enrolled
decision and `enrolAs`: the decision's `enrolAs` for a customer ID experiment, otherwise the
visitor ID it was decided for, lowercased. An item for a deployed experiment names its deployed
variant, with the visitor ID or, for a customer ID experiment, the enrolment ID derived from the
customer ID as `enrolAs` is (`spec/SPEC.md`, section 4); it counts toward sessions and enrols
nobody. Answers `{ "ok": true, "accepted": 1 }`. Exposures for an experiment that is neither
running nor deployed are ignored, and so are repeats of an experiment and `enrolAs` already
reported. Do not report decisions you also put in a page seed: the snippet reports those.

### `GET /sdk/config`

What the SDK polls: the website's experiments, their variants, weights, payloads and targeting
rules, and the salt they are hashed with. 120 requests a minute per key.

```sh
curl https://tracking.pertento.ai/sdk/config \
  -H "Authorization: Bearer $PERTENTO_SERVER_KEY" \
  -H 'If-None-Match: "etag-from-the-last-response"'
```

200 with an `ETag`, or 304 when the config is unchanged. The response carries the website's
secret salt, so treat it like the key. The hashing rules an SDK in another language must follow
are in [`spec/SPEC.md`](./spec/SPEC.md), with test vectors in
[`spec/vectors.json`](./spec/vectors.json).

## License

MIT
