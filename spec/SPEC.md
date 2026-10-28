# Pertento flag evaluation: wire spec, version 2

This file is binding. An SDK in another language implements exactly what is written here and
passes every case in [`vectors.json`](./vectors.json). The TypeScript evaluator in this
repository (`src/evaluator`) is the reference implementation; where the two ever disagree,
this file is a bug report against one of them, and the vectors decide which.

The key words MUST, MUST NOT and SHOULD are used in their RFC 2119 sense.

**Version 2** (from version 1) adds feature flags: an experiment may carry a `rollout`, which is
decided by sticky rollout bucketing and rings (section 8) instead of the weight walk, and a new
decision reason, `ring`. Nothing else changed: every bucket, enrolment ID, weight walk and
decision of a version 1 config is the same under version 2. A writer still emits version 1 for a
config with no rollout, and a version 2 reader accepts both (section 9).

## 0. Where this spec lives

This repository (`Pertento/pertento-sdk-js`) is **canonical** for the evaluator, this file and
`vectors.json`. The Pertento tracking server has its own implementation, which answers
`/sdk/decide` and `/sdk/events`. It MUST pass the same `vectors.json`, byte for byte the file
committed here, or the server and the SDK would put one person in two different arms.

Any change to hashing, to the decision rules or to the config shape is a new version of this spec:
it bumps `SDK_CONFIG_VERSION` (and the version in this file's title) and comes with newly generated
vectors, and every implementation adopts it together. A change that only adds an optional config
field needs no bump (section 9).

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
`golang.org/x/text/cases.Lower(language.Und)`. PHP's `strtolower` does **not** either (it is
byte-wise ASCII only). `mb_strtolower($s, 'UTF-8')` applies the full SpecialCasing mappings
since PHP 7.3 but the Final_Sigma rule only since PHP 8.3, so a PHP port needs 8.3 or later, or
must apply Final_Sigma itself. Whatever the language, the requirement is the behaviour above, and
the vectors are the check: they include both cases, and each bucket vector carries the exact
`message`, so a case-mapping bug is told apart from a hashing bug.

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

1. Drop every entry of `variants` that is not an object (a JSON object: not null, not an array).
   Sort the rest by `id` ascending. The config writer already does; a reader MUST sort again.
   The sort MUST be stable: variants with equal ids keep their order in the config (the writer
   never emits equal ids, so this matters only for hand-edited data, but it fixes which one is
   control). **Control is the variant with the lowest id.**
2. A variant's weight is its `weight` if that is a finite number greater than 0, floored to an
   integer; anything else (negative, zero, NaN, infinite, not a number) is 0. The writer emits
   only integers in `0..10000` (the column is a smallint of basis points); the rule above is for
   anything else a reader is handed.
3. `total` = the sum of the weights. If `total` is 0 the pick is **none**.
4. `point = floor(bucket * total / 10000)`. With the usual total of 10000 this is the bucket.
   A total other than 10000 is scaled, not truncated, so a stored distribution that does not sum
   to 10000 still splits proportionally (the browser runtime normalises the same way).
5. Walk the sorted variants: if `point < weight`, pick this variant; otherwise
   `point -= weight` and continue.

Integer arithmetic is exact here: `bucket * total` stays far below 2^53 for any total the writer
can produce (at most 10000 per variant).

## 6. Decisions

`decide(config, salt, key, visitorId?, id?, attributes?)` returns a Decision:

```
{ experimentId, variantId, variantKey, payload, enrolled: true,  enrolAs? }
{ experimentId, variantId, variantKey, payload, enrolled: false, reason }
```

`reason` is one of `unknown-key`, `not-running`, `no-id`, `wrong-id-kind`, `targeting`, `ring`,
and is present on **every** `enrolled: false` and absent on every `enrolled: true`. `ring` is only
ever given for a feature flag (section 8). `enrolAs` is present
only on an enrolled decision of a `customer_id` experiment.

An ID is **present** only when it is a non-empty string. An entry of `config.experiments` that is
not an object is skipped, as if absent; a malformed config never makes `decide` fail. The checks
run in this order; the first that applies decides:

| #   | Condition                                                                                                                  | Result                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No experiment in `config.experiments` has `key` === the requested key (case-sensitive; first match wins).                  | `experimentId`, `variantId`, `variantKey`, `payload` all `null`; `unknown-key`.                                                                                               |
| 2   | `status` is not `"Running"`.                                                                                               | `not-running`. For `"Deployed"`, the variant whose `id` is `deployedVariantId`; if that is null or names no variant, control. For any other status, control. No ID is needed. |
| 3   | `bucketOn` is neither `"visitor"` nor `"customer_id"`.                                                                     | control; `wrong-id-kind` (no ID the caller can give fits it), whatever IDs are given.                                                                                         |
| 4   | The ID `bucketOn` needs is not present (`visitorId` for `visitor`, `id` for `customer_id`), and neither is the other kind. | control; `no-id`.                                                                                                                                                             |
| 5   | The ID `bucketOn` needs is not present, but the other kind is.                                                             | control; `wrong-id-kind`.                                                                                                                                                     |
| 6   | The attribute rules (section 7) do not match `attributes`.                                                                 | control; `targeting`.                                                                                                                                                         |
| 7   | `bucket = bucket(salt, experiment.id, bucketingId)` (section 3); pick (section 5) is none.                                 | control; `not-running` (an experiment that admits nobody behaves as not running; see below).                                                                                  |
| 8   | Otherwise.                                                                                                                 | the picked variant; `enrolled: true`; for `customer_id`, `enrolAs` = the enrolment ID that was bucketed.                                                                      |

For a `customer_id` experiment, step 7 first computes `enrolAs = enrolmentId(salt, id)` from the
raw customer ID (section 4), then buckets on `enrolAs`. For a `visitor` experiment it buckets on
`visitorId`.

Step 3 is deliberately not "treat it as `visitor`": an unknown `bucketOn` comes from a newer writer
or bad data, and guessing an ID kind could enrol people on an identity the experiment never meant
to use. Refusing costs an enrolment; guessing could cost a wrong one.

Step 7 finding no variant needs every weight to be 0 (or no variants at all). The API refuses to
start an experiment whose weights do not sum to 10000, so this happens only with hand-edited
data; none of the five reasons fits it exactly, and to the caller it is indistinguishable from
an experiment that is not running.

"Control" in a not-enrolled decision means control's `id`, `key` and `payload`; with no variants
at all it is `null`, `null`, `null`. `payload` is passed through as the config holds it.

When both IDs are given, each experiment uses the one its `bucketOn` names and ignores the other.

An experiment with a `rollout` (a feature flag) follows this table with the changes in section 8:
"control" is Off, a rollout that cannot be used is not running, rings come after step 6, and step
7 compares the bucket with the rollout limit instead of walking the weights.

`decideAll` is `decide` for every experiment, keyed by flag key (first experiment wins on a
duplicate key). In the reference implementation the result is an object with a null prototype,
so looking up a key no experiment has (`toString`, `__proto__`) gives `undefined`; a port uses a
plain map with no inherited entries.

**Variant map** (what a server-reported conversion is attributed with): for every experiment
whose decision is enrolled, `{ decimal(experimentId): decimal(variantId) }`. Only Running
experiments can be enrolled, so Deployed ones never appear; an experiment or variant ID that is
not an integer is left out. No ID gives `{}`.

## 7. Attribute rules

A rule is `{ attribute: string, operator, value? }`. Rules are ANDed; an empty list matches
everyone. An experiment whose `targeting` is `null` or absent is treated as an empty list and
matches everyone (the writer always emits an array; the column is not null). A `targeting` that is
present but not an array matches nobody. Matching **never throws**: anything malformed or of the wrong type is a non-match.

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

## 8. Rollouts (feature flags)

An experiment whose `rollout` is present and not `null` is a **feature flag**. (A `rollout` that is
absent or `null` is an ordinary experiment, decided exactly as section 6 says.)

```
SdkRollout = {
  onVariantId: number,                       // the On variant
  rolloutBp: number,                         // basis points of buckets that are On
  holdbackBp: number,                        // basis points at the top that are always Off
  rings: SdkRing[]                           // evaluated in order before the bucket
}
SdkRing = { rules: AttributeRule[], ids?: string[], serve: "on" | "off" }
```

A flag has two variants, **On** and **Off**. Its side depends only on the person's bucket and a
limit, never on the variant weights (the writer stores 5000/5000; a reader ignores them), so
**raising `rolloutBp` only ever moves people from Off to On**, never back: a ramp only adds people.

### 8.1 On and Off

Take `variants` as section 5 step 1 gives them (entries that are not objects dropped, sorted
stably by id ascending). Then:

- **Off** is the first of those variants whose `id` is not `rollout.onVariantId` (strict
  equality, no coercion: `"9102"` is not `9102`), or none if there is no such variant. When
  `rollout` is not an object, `onVariantId` is absent and Off is the first variant. With a
  well-formed flag Off is normally the control, the variant with the lowest id, but it need not
  be: Off is whichever variant is not On.
- The rollout is **unusable** when any of these holds: `rollout` is not a JSON object; there are
  not exactly two variants; Off is none; no variant's `id` is `onVariantId`; `rings` is present,
  not `null`, and not an array.
- Otherwise **On** is the variant whose `id` is `onVariantId`.

Wherever section 6 answers "control" for a flag, the answer is **Off** (its `id`, `key` and
`payload`; `null`, `null`, `null` when Off is none).

### 8.2 The limit

```
clamp(x) = min(10000, max(0, floor(x)))   if x is a finite number
         = 0                              otherwise (absent, null, a string such as "5000", NaN, ±Infinity)
limit    = min(clamp(rolloutBp), 10000 - clamp(holdbackBp))
```

So `rolloutBp: 25000` is 10000, `-1` is 0, `2500.9` is 2500, and a holdback of 10000 or more makes
the limit 0. Buckets `>= 10000 - holdback` are the **holdback**: at a rollout of 100% they are still
Off, which keeps a comparison group.

### 8.3 Decision order for a flag

| #   | Condition                                                        | Result                                                                                                |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1-2 | As section 6.                                                    | As section 6, with Off for control. A Deployed flag answers its deployed variant, else Off.           |
| 2a  | The rollout is unusable (8.1).                                   | Off; `not-running`. Checked before any ID, so it is the answer with or without one.                   |
| 3-5 | As section 6.                                                    | Off; `wrong-id-kind` or `no-id`.                                                                      |
| 6   | The experiment's `targeting` rules do not match (eligibility).   | Off; `targeting`. Eligibility comes before rings: a ring cannot let in someone who is not eligible.   |
| R   | A ring matches (8.4). The first that matches, in order, decides. | On for `serve: "on"`, Off for `serve: "off"`; `ring`, **not enrolled**. Nothing is bucketed.          |
| B   | Otherwise: `bucket = bucket(salt, experiment.id, bucketingId)`.  | On if `bucket < limit`, else Off. **Enrolled either way**; for `customer_id`, `enrolAs` as section 6. |

The bucketing ID is the one section 3 names: the visitor ID for `visitor`, the derived enrolment ID
for `customer_id`. Step B never returns "none": a flag with a usable rollout always enrols.

Ring and targeting answers are not enrolled because they are not a random sample: they must not
enter the On/Off comparison. A person bucketed Off is enrolled, because Off is the comparison group.
The variant map (section 6) therefore holds every bucketed flag, On or Off, and no ring answer.

### 8.4 Ring matching

A ring matches when every one of these holds:

- it is a JSON object;
- its `serve` is exactly `"on"` or `"off"` (anything else: the ring never matches);
- its `rules` match the attributes by section 7, with `rules` absent or `null` read as an empty list
  (which matches everyone) and a `rules` that is not an array matching nobody;
- its `ids`, when present and not `null`, is an array holding the person's ID. Only string elements
  count. The ID is the **raw ID `bucketOn` names**, never the enrolment ID: for `visitor`, the
  visitor ID, compared case-insensitively (`lowercase` of section 3 on both sides, as a UUID's
  casing never moves anyone); for `customer_id`, the customer's own ID, compared exactly
  (case-sensitive, as section 4). An `ids` that is present but not an array never matches.

A ring with no `ids` and an empty `rules` matches everyone who reaches it.

### 8.5 What a port can check

- **Stickiness.** For any ID, with the salt, experiment, holdback, rings and attributes fixed, the
  side is a non-decreasing function of `rolloutBp`: once On, On at every higher rollout.
- **Holdback.** A bucket `>= 10000 - clamp(holdbackBp)` is never On through step B, at any
  `rolloutBp` (a ring can still serve it On).
- **Boundary.** `bucket = limit - 1` is On; `bucket = limit` is Off. The vectors carry visitor IDs
  that land exactly on both sides of several limits.

## 9. Config (`GET /sdk/config` body)

```
SdkConfig = {
  version: 1 | 2,                            // 2 only when an experiment has a rollout
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
  targeting: AttributeRule[],
  rollout?: SdkRollout                       // feature flags only (section 8)
}
SdkVariant = { id: number, key: string, weight: number, payload: any JSON }
```

A reader MUST treat a config whose `version` it does not know as no config at all (every key is
`unknown-key`); the evaluator does not check `version` itself, the SDK does before calling it.
A reader MUST ignore fields it does not know, so fields can be added without a version bump, as
long as a reader that ignores them still decides the same. `rollout` is not such a field: a
version 1 reader would ignore it and split the flag by its stored weights, which is why it bumped
the version to 2. A version 1 reader therefore refuses a version 2 config, and every key it is
asked for is `unknown-key` (the caller's default, which for a flag should be Off) until it is
upgraded.

**Writers** emit `version: 1` for a config in which no experiment has a `rollout` (absent or
`null`), and `version: 2` only when at least one does (the reference implementation's
`configVersionFor`). A config without flags so stays readable by version 1 readers, which decide it
exactly as a version 2 reader does.

**Readers** of this spec accept versions **1 and 2** (`SUPPORTED_CONFIG_VERSIONS`), and decide both
by this document: version 1 is version 2 without any `rollout`. Any other version is refused as
above.

## 10. Seed (`window.PertentoSeed`)

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

## 11. Test vectors

[`vectors.json`](./vectors.json) is generated by `scripts/generate-vectors.ts` from the
reference implementation, after the RFC 4231 test passed, and committed. It is never regenerated
without bumping the version in this file. It holds:

- `buckets`: `{ salt, experimentId, id, message, bucket }`, including uppercase IDs (which must
  bucket like their lowercase form; these exercise `bucket` directly, and a `customer_id` experiment passes it the enrolment ID), multi-byte, `İ` and final-sigma IDs;
- `enrolmentIds`: `{ salt, customerId, enrolmentId }`;
- `weightWalks`: `{ name, variants, bucket, expected }`, the variant id section 5 picks (or `null`
  for none) at chosen buckets: both sides of each boundary of a 70/30 split, in basis points and
  totalling 100, a total above 10000, and invalid weights. These tell `floor(bucket * total /
10000)` apart from `bucket % total`;
- `decisions`: `{ name, input: { key, visitorId?, id?, attributes? }, expected }`, run against
  `decisionConfig` with `decisionSalt`, covering every reason, and `Cust-1` and `cust-1` as two customers with different enrolment IDs and variants;
- `variantMaps`: `{ name, input, expected }`, same config and salt;
- `rolloutDecisions`: `{ name, input, bucket, expected }`, run against `rolloutConfig` (feature flags
  only, so none of the vectors above change) with `decisionSalt`. They cover both sides of the limit
  (`limit - 1` and `limit`) for a plain rollout, a holdback at 100%, a holdback that caps the
  rollout, clamping above 10000 and below 0, fractional and string basis points, rings (by rule, by
  visitor ID in another case, by customer ID case-sensitively, rules and ids together, first match
  wins, eligibility before rings, malformed rings), the On variant having the lower id, every kind
  of unusable rollout, a Deployed flag, and `rollout: null`. `bucket` is the bucket an enrolled
  decision was made at (on `enrolAs` for `customer_id`), `null` for one that is not enrolled; it is
  there to tell a bucketing bug from a rollout bug;
- `rolloutVariantMaps`: `{ name, input, expected }`, against `rolloutConfig` with `decisionSalt`.

`decisionConfig` has no rollouts and is `version: 1`; `rolloutConfig` has them and is `version: 2`,
as a writer would stamp them (section 9). `specVersion` is the version of this file, 2.

A port passes when it reproduces every `expected` exactly (deep equality of the JSON, with an
absent optional field distinct from a `null` one).
