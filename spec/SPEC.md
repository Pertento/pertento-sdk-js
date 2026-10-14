# Pertento flag evaluation: wire spec, version 1

This file is binding. An SDK in another language implements exactly what is written here and
passes every case in [`vectors.json`](./vectors.json). The TypeScript evaluator in this
repository (`src/evaluator`) is the reference implementation; where the two ever disagree,
this file is a bug report against one of them, and the vectors decide which.

The key words MUST, MUST NOT and SHOULD are used in their RFC 2119 sense.

## 0. Where this spec lives

This repository (`Pertento/pertento-sdk-js`) is **canonical** for the evaluator, this file and
`vectors.json`. The Pertento tracking server has its own implementation, which answers
`/sdk/decide` and `/sdk/events`. It MUST pass the same `vectors.json`, byte for byte the file
committed here, or the server and the SDK would put one person in two different arms.

Any change to hashing, to the decision rules or to the config shape is a new version of this spec:
it bumps `SDK_CONFIG_VERSION` (and the version in this file's title) and comes with newly generated
vectors, and every implementation adopts it together. A change that only adds an optional config
field needs no bump (section 8).

## 1. Strings and bytes

- Every string that is hashed is encoded as **UTF-8**, with no byte-order mark, no trailing NUL,
  and **no Unicode normalisation** (an NFD "å" and an NFC "å" are different IDs).
- Strings are expected to be well-formed Unicode. The reference implementation encodes a lone
  UTF-16 surrogate as U+FFFD (the WHATWG `TextEncoder` rule); a port SHOULD do the same, and a
  caller SHOULD NOT send ill-formed strings.
- An experiment ID is written in decimal: ASCII digits, no sign, no leading zeros, no exponent,
  no separators (`501`, never `+501`, `0501` or `5.01e2`).

## 2. HMAC

`HMAC(key, message)` is HMAC-SHA256 (RFC 2104 with SHA-256), where:

- the **key** is the UTF-8 bytes of the website's salt string **exactly as the config response
  gives it**. The salt happens to be a hex string; it is **not** hex-decoded. A 64-character hex
  salt is a 64-byte key.
- the **message** is the UTF-8 bytes of the message string.

The salt MUST be non-empty. (Web Crypto refuses a zero-length HMAC key, so the reference
implementation rejects; a port MUST NOT silently accept one.)

Check: `HMAC("Jefe", "what do ya want for nothing?")` is
`5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843` (RFC 4231, test case 2).

## 3. Bucket

```
message = decimal(experimentId) + ":" + lowercase(id)
digest  = HMAC(salt, message)
bucket  = uint32_big_endian(digest[0..4]) % 10000
```

`bucket` is an integer in `[0, 10000)`. `id` is the **bucketing ID**:

- for a `visitor` experiment, the visitor ID (a UUID, so lowercasing only normalises its hex);
- for a `customer_id` experiment, the **derived enrolment ID** of the customer ID (section 4),
  never the customer's raw ID. The derived ID is already a lowercase UUID, so lowercasing it
  changes nothing.

So one customer ID gives one enrolment ID gives one bucket, and the customer's own ID is never
lowercased or otherwise normalised on its way to a bucket.

`lowercase` is the **Unicode default full lowercase mapping, locale-independent**: what
JavaScript's `String.prototype.toLowerCase()` does. That includes the unconditional SpecialCasing
mappings and the Final_Sigma rule, so:

- `"İ"` (U+0130) becomes `"i̇"` (`i` + U+0307), two code points;
- a word-final `"Σ"` becomes `"ς"` (U+03C2), any other `"Σ"` becomes `"σ"`.

Java's `toLowerCase(Locale.ROOT)` and Python's `str.lower()` do this. Go's `strings.ToLower`
does **not** (it maps code point by code point); a Go port uses
`golang.org/x/text/cases.Lower(language.Und)`. The vectors include both cases, and each bucket
vector carries the exact `message`, so a case-mapping bug is told apart from a hashing bug.

The modulo bias of `2^32 % 10000` is 7296 values in 2^32, which is negligible.

## 4. Enrolment ID

The UUID a `customer_id` experiment enrols under, so Pertento's enrolment table never holds the
customer's own ID:

```
digest = HMAC(salt, "id:" + customerId)
bytes  = digest[0..16]
bytes[6] = (bytes[6] & 0x0f) | 0x80     // version 8
bytes[8] = (bytes[8] & 0x3f) | 0x80     // variant 10xx
enrolmentId = lowercase hex of bytes, hyphenated 8-4-4-4-12
```

**Customer IDs are opaque and case-sensitive.** The customer ID is used exactly as given: not
lowercased, not trimmed, not Unicode-normalised. `Cust-1` and `cust-1` are two people, with two
enrolment IDs and, because a `customer_id` experiment buckets on the enrolment ID (section 3),
two independent buckets. The enrolment ID is computed first and is both what the decision's
`enrolAs` carries and what is bucketed.

## 5. Variant pick (weight walk)

Input: the experiment's variants and a bucket.

1. Sort the variants by `id` ascending. The config writer already does; a reader MUST sort again.
   **Control is the variant with the lowest id.**
2. A variant's weight is its `weight` if that is a finite number greater than 0, floored to an
   integer; anything else (negative, zero, NaN, infinite, not a number) is 0.
3. `total` = the sum of the weights. If `total` is 0 the pick is **none**.
4. `point = floor(bucket * total / 10000)`. With the usual total of 10000 this is the bucket.
   A total other than 10000 is scaled, not truncated, so a stored distribution that does not sum
   to 10000 still splits proportionally (the browser runtime normalises the same way).
5. Walk the sorted variants: if `point < weight`, pick this variant; otherwise
   `point -= weight` and continue.

Integer arithmetic is exact here: `bucket * total` stays far below 2^53.

## 6. Decisions

`decide(config, salt, key, visitorId?, id?, attributes?)` returns a Decision:

```
{ experimentId, variantId, variantKey, payload, enrolled: true,  enrolAs? }
{ experimentId, variantId, variantKey, payload, enrolled: false, reason }
```

`reason` is one of `unknown-key`, `not-running`, `no-id`, `wrong-id-kind`, `targeting`, and is
present on **every** `enrolled: false` and absent on every `enrolled: true`. `enrolAs` is present
only on an enrolled decision of a `customer_id` experiment.

An ID is **present** only when it is a non-empty string. The checks run in this order; the first
that applies decides:

| #   | Condition                                                                                                                  | Result                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No experiment in `config.experiments` has `key` === the requested key (case-sensitive; first match wins).                  | `experimentId`, `variantId`, `variantKey`, `payload` all `null`; `unknown-key`.                                                                                               |
| 2   | `status` is not `"Running"`.                                                                                               | `not-running`. For `"Deployed"`, the variant whose `id` is `deployedVariantId`; if that is null or names no variant, control. For any other status, control. No ID is needed. |
| 3   | The ID `bucketOn` needs is not present (`visitorId` for `visitor`, `id` for `customer_id`), and neither is the other kind. | control; `no-id`.                                                                                                                                                             |
| 4   | The ID `bucketOn` needs is not present, but the other kind is.                                                             | control; `wrong-id-kind`.                                                                                                                                                     |
| 5   | The attribute rules (section 7) do not match `attributes`.                                                                 | control; `targeting`.                                                                                                                                                         |
| 6   | `bucket = bucket(salt, experiment.id, bucketingId)` (section 3); pick (section 5) is none.                                 | control; `not-running` (an experiment that admits nobody behaves as not running; see below).                                                                                  |
| 7   | Otherwise.                                                                                                                 | the picked variant; `enrolled: true`; for `customer_id`, `enrolAs` = the enrolment ID that was bucketed.                                                                      |

For a `customer_id` experiment, step 6 first computes `enrolAs = enrolmentId(salt, id)` from the
raw customer ID (section 4), then buckets on `enrolAs`. For a `visitor` experiment it buckets on
`visitorId`.

Step 6 finding no variant needs every weight to be 0 (or no variants at all). The API refuses to
start an experiment whose weights do not sum to 10000, so this happens only with hand-edited
data; none of the five reasons fits it exactly, and to the caller it is indistinguishable from
an experiment that is not running.

"Control" in a not-enrolled decision means control's `id`, `key` and `payload`; with no variants
at all it is `null`, `null`, `null`. `payload` is passed through as the config holds it.

When both IDs are given, each experiment uses the one its `bucketOn` names and ignores the other.

`decideAll` is `decide` for every experiment, keyed by flag key (first experiment wins on a
duplicate key).

**Variant map** (what a server-reported conversion is attributed with): for every experiment
whose decision is enrolled, `{ decimal(experimentId): decimal(variantId) }`. Only Running
experiments can be enrolled, so Deployed ones never appear; an experiment or variant ID that is
not an integer is left out. No ID gives `{}`.

## 7. Attribute rules

A rule is `{ attribute: string, operator, value? }`. Rules are ANDed; an empty list matches
everyone. Matching **never throws**: anything malformed or of the wrong type is a non-match.

`attributes` is a flat object. An attribute is **present** when it is an own property (never
inherited: `toString`, `__proto__` and the like are absent) and its value is neither `null` nor
`undefined`. "Number" means a finite IEEE-754 double; NaN and ±Infinity match nothing. No
operator coerces between types: `"5"` is not `5`, `"true"` is not `true`.

| Operator | `value`                      | Matches when                                                                                                                                                                              |
| -------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exists` | ignored (normally absent)    | the attribute is present, whatever its type (`""`, `0` and `false` are present).                                                                                                          |
| `equals` | string, number or boolean    | the attribute is a string, number or boolean and `===` the value. Same type, same value; strings compare by code unit, case-sensitively. An array or object on either side never matches. |
| `in`     | array of strings and numbers | the attribute is a string or number and some element `===` it. A boolean attribute never matches.                                                                                         |
| `not in` | array of strings and numbers | the attribute is **present**, a string or number, and no element `===` it.                                                                                                                |
| `<`      | number                       | the attribute is a number and `attribute < value`.                                                                                                                                        |
| `>`      | number                       | the attribute is a number and `attribute > value`.                                                                                                                                        |

A `value` of the wrong shape for its operator (a non-array for `in`, a string for `<`), an unknown
operator, or a rule that is not an object with a string `attribute` never matches.

**A missing attribute fails `not in`.** It fails every operator except `exists`, and `not in` is
no exception: a rule says something about an attribute, and a visitor the caller told us nothing
about is not known to satisfy it. The alternative ("missing is not in the list, so it matches")
turns `country not in [US]` into "everyone whose country we do not know, too", which silently
widens an experiment whenever a caller forgets to pass an attribute. To include unknown values
deliberately, a customer passes a sentinel such as `"unknown"`.

## 8. Config (`GET /sdk/config` body)

```
SdkConfig = {
  version: 1,
  websiteId: number,
  generatedAt: number,                       // epoch ms
  trackingMethod: "ga4" | "matomo" | "pertento" | "server" | null,
  experiments: SdkExperiment[]
}
SdkExperiment = {
  id: number,
  key: string,                               // the flag key
  status: "Running" | "Deployed",
  bucketOn: "visitor" | "customer_id",
  variants: SdkVariant[],                    // sorted by id ascending
  deployedVariantId: number | null,
  targeting: AttributeRule[]
}
SdkVariant = { id: number, key: string, weight: number, payload: any JSON }
```

A reader MUST treat a config whose `version` it does not know as no config at all (every key is
`unknown-key`); the evaluator does not check `version` itself, the SDK does before calling it.
A reader MUST ignore fields it does not know, so fields can be added without a version bump.

## 9. Seed (`window.PertentoSeed`)

```
Seed = {
  visitorId?: string,                        // a UUID
  assignments: { [decimal experimentId]: { variantId: decimal string, enrolAs?: UUID } }
}
```

Only enrolled decisions go in. The browser runtime validates every field and drops what it does
not recognise, so a seed is data, never trusted as typed.

Serialised for a `<script>` element: `JSON.stringify` and then every `<`, `>`, `&`, U+2028 and
U+2029 written as the six-character escape `\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029`
(lowercase hex). Those characters occur only inside JSON strings, where the escape means the same
character, so `JSON.parse` of the output equals the seed, and no value can close the script
element or open an HTML comment.

## 10. Test vectors

[`vectors.json`](./vectors.json) is generated by `scripts/generate-vectors.ts` from the
reference implementation, after the RFC 4231 test passed, and committed. It is never regenerated
without bumping the version in this file. It holds:

- `buckets`: `{ salt, experimentId, id, message, bucket }`, including uppercase IDs (which must
  bucket like their lowercase form; these exercise `bucket` directly, and a `customer_id` experiment passes it the enrolment ID), multi-byte, `İ` and final-sigma IDs;
- `enrolmentIds`: `{ salt, customerId, enrolmentId }`;
- `decisions`: `{ name, input: { key, visitorId?, id?, attributes? }, expected }`, run against
  `decisionConfig` with `decisionSalt`, covering every reason, and `Cust-1` and `cust-1` as two customers with different enrolment IDs and variants;
- `variantMaps`: `{ name, input, expected }`, same config and salt.

A port passes when it reproduces every `expected` exactly (deep equality of the JSON, with an
absent optional field distinct from a `null` one).
