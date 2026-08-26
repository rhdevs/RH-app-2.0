# Events: questions, attendance and dashboards — a Phase 1 correction, then Phases 2, 3 and 4

**Ask:** four things, in this order. (A) Fix the Phase 1 defect: the head must key in
**everything** on **one screen** and press **one** primary action. (B) Custom signup
questions, with a real form builder. (C) QR attendance, organiser-scans-resident. (D)
Dashboards for the head and for the JCRC.

**Scope:** Part A is a correction to shipped, live code and is the highest priority in
this document — it is a product ruling that a technical constraint quietly overrode.
Parts B, C and D are Phases 2, 3 and 4. Nothing here builds notifications, a term model,
a waitlist, or an events feed for Telegram.

**Status:** proposal. Nothing below is implemented. Base: `main` @ `f79d3cc` (PR #97),
live in production with `events.enabled = "on"`.

**Prior plan:** `docs/plans/events/01-registration-rework.md`. **Its decisions D-1…D-27 and
traps T-1…T-18 remain binding except where this document overrules them by number.** Exactly
one is overruled: **D-14**. Numbering continues from where it stopped — decisions start at
**D-28**, traps at **T-19**, contradictions at **C-5**.

**Convention note:** this repo's plans live at `docs/plans/<area>/NN-topic.md`
(`docs/plans/rbac/01-data-model.md`, `docs/plans/cca/01-group-interview-slots.md`,
`docs/plans/events/01-registration-rework.md`). This file follows that, and its structure
follows plan 01's.

---

## READ THIS FIRST — the five mistakes that will actually ship

Everything else in this document is a detail. These five compile cleanly, pass review, and
are wrong in production. Each is repeated in full in §14 with its reasoning; they are here
because §14 is two thousand lines away.

### 1. `npm run db:generate` runs `prisma migrate dev`. It is not `prisma generate`.

`package.json:8-9` —

```json
"db:generate": "prisma migrate dev",
"db:push": "prisma db push",
```

Plan 01 §9.3, the `email_unique_ci` block above `model User` in `schema.prisma`,
`index-census.mjs:31-33` and `set-events-flag.mjs:16-37` all say **`prisma generate`, never
a push**. And the npm script whose *name* most resembles `prisma generate` runs
`prisma migrate dev` — a migration command — against a MongoDB cluster whose one
irreplaceable index is invisible to Prisma. A coder who reads "run prisma generate" and
types the obvious npm script does the forbidden thing.

**Run `npx prisma generate`. Never `npm run db:generate`. Never `npm run db:push`.** D-80
deletes both scripts.

### 2. A Prisma `@unique` on MongoDB creates nothing at all

`create-auth-allowlist.mjs:29-33` states it outright:

> "A Prisma `@unique` on a Mongo model is a CLIENT-SIDE TYPE ASSERTION. Until the index
> exists in the cluster, the database enforces nothing … and the `P2002` refusal — which is
> supposed to be how a duplicate is caught — can never fire, because Mongo never raises it."

Part C's `EventAttendance` re-scan idempotency and Part B's `questionID` allocation both rest
on `P2002`. If the two compound-unique indexes are not created with `createIndexes`, **both
silently degrade to no protection at all, with a green build and a passing manual test.**
§9 is the procedure and it has a section of its own for exactly this reason.

### 3. A server component must never pass a function prop to a client component

This shipped in Phase 1 and killed all five authoring routes. `tsc`, ESLint, `next build`
and two review agents all passed; React throws at *render*. The surviving warning is at
`EventCreateForm.tsx:33-38` and `EventManage.tsx:821-823`:

> "`manageHrefBase` is a STRING, not a builder function, and must stay one … That throw
> happens at RENDER, so tsc, lint and `next build` all pass while every authoring route
> 500s."

This plan creates **three** new route/component pairs. Every one is checked by name in
§13.1. **Pass strings and numbers. Build URLs client-side.**

### 4. The answers write goes INSIDE `withEventLock`, in the same `create` call

`R:1961-1997`. The capacity count and the signup create are already serialised by
`withEventLock`. The answers must ride on the **same `eventSignup.create`** — one document,
one write — not a second write after it. A second write can be reached after the P2002
swallow at `:1786-1797`, which returns success **without** writing, so the answers of a
retried submission would be dropped while the caller is told it worked. See T-23.

### 5. `EXT:` identities contain a colon, so `:` cannot delimit a signed payload

`src/lib/identity.ts:127` — `EXT_ID = /^EXT:[A-Z0-9_]{3,32}$/`. A canonical NUSNET id cannot
contain `:` (`identity.ts:108`), which is the entire basis of the two namespaces being
*provably* disjoint — but an **EXT** id can and does. A payload spelled
`"event-checkin:" + userID + ":" + window` is ambiguous for `EXT:HALLOFFICE`, and an
ambiguous HMAC payload is a forgery primitive.

Use `|`, which neither namespace can contain, exactly as `admin.ts:352-365` already does for
the bulk-import plan token. See T-25.

---

## 0. Ground truth

### 0.0 A BLOCKING WARNING ABOUT EVERY DATA FIGURE IN THIS SECTION

**The production database was NOT reachable from the environment this plan was written in.**
Measured twice, once through Prisma and once by running the repo's own census:

```
$ node scripts/remediation/index-census.mjs
Kind: Server selection timeout: No available servers.
Topology: { Type: ReplicaSetNoPrimary, Set Name: atlas-aldpli-shard-0,
  Servers: [ cluster0-shard-00-0{0,1,2}.0urzo.mongodb.net:27017 — I/O error: timed out ] }
  COMMANDS THAT FAILED (these are NOT measured absences): … every collection …
  A census with a failed read is a PARTIAL census.
```

> **RE-MEASURED 2026-08-26, THIRD ATTEMPT (Part B reconciliation pass). STILL UNREACHABLE —
> AND THE DIAGNOSIS ABOVE WAS WRONG.**
>
> The earlier text called this "an Atlas IP-allowlist refusal". **It is not.** That was
> inferred, not tested, and acting on it costs a wasted cycle: adding an IP to the Atlas
> allowlist will not fix it. Isolated by probing rather than guessing:
>
> | Probe | Result |
> |---|---|
> | DNS SRV for the cluster | resolves — all three shard hosts returned |
> | ICMP ping `cluster0-shard-00-00` (34.126.102.172) | **succeeds** — packets reach Atlas |
> | TCP to that host **:27017** | times out |
> | TCP to `portquiz.net:27017` (an unrelated host that accepts any port) | **times out** |
> | TCP to `portquiz.net:80` and `:8080` | 200 OK |
> | `https://www.google.com` | 200 OK, 0.17 s |
> | `api.ipify.org` | DNS-sinkholed to `sinkhole.nus.edu.sg` (10.2.32.196) |
>
> General internet works; **port 27017 fails to _every_ host, not just Atlas.** The DNS
> sinkhole identifies this machine as on the **NUS campus network**. So the block is an
> **egress firewall rule on 27017**, upstream of Atlas entirely — not the allowlist, not the
> credentials, not the cluster. Re-running with the sandbox disabled gave the identical
> timeout, so it is not a sandbox artifact either.
>
> **What actually unblocks it:** run from any non-NUS network (a phone hotspot is enough), or
> from Vercel. The census script needs no changes.
>
> **No writes of any kind reached the database during this pass.** The only commands
> dispatched were `ping` and `listCollections`, and both failed at server selection.

**Consequence, stated so nobody reads past it:** every production *count* below is
**carried forward from plan 01's measurement of 2026-08-26 and is UNVERIFIED by this plan.**
Three of plan 01's decisions (D-1, D-4, D-22) and two of this one's (D-30, D-52) depend on
those numbers still holding. §12.1 makes re-measuring them a **blocking** pre-flight step.

Every claim in this document about **code** was read from the working tree at `f79d3cc` and
is cited `file:line`. Every claim about **data** is a carried-forward figure and is labelled
as one. Do not let the two blur.

*Operational note:* run the census with a redirect (`> census-before.txt`), never through a
pipe. `node … | tail` reports the exit code of `tail`, so a completely failed census looks
like a clean exit 0. Plan 01 §9.2 already spells it with a redirect; keep it that way.

### 0.1 Carried-forward production figures (UNVERIFIED — re-measure, §12.1)

| Measure | Plan 01, 2026-08-26 | Why it matters here |
|---|---|---|
| `Event` rows | 0 | D-30's blank-draft reuse and D-33's sweep are cheap while this is small |
| `EventSignup` rows | 0 | D-49: the embedded answers list lands on an empty collection, so T-24's absent-key hazard has no legacy population |
| `EventLock` rows | 0 at rest | a standing non-zero count is a leaked lock, and D-42 puts more traffic through it |
| `Bookings` / `Bookings where ccaID = 0` | 17,456 / 3,839 | D-8's sentinel. **This plan does not touch `Bookings`.** |
| `events.enabled` | `"on"` since 2026-07-25 | the brief states production still has 0 Event rows |
| `RoleAuditLog` where `action` starts `event.` | 0 | D-53 adds one action name and retires none |

The brief states production has **0 Event rows** — a month after the feature was switched on
and a day after PR #97 landed. Parts B, C and D are therefore being built onto a feature
nobody has used once. **That is the strongest possible argument for doing Part A first**, and
for not letting it be deferred as "polish".

> **⚠ THE "0 Event rows" FIGURE IS NOW KNOWN TO BE FALSE, AND IT WAS LOAD-BEARING.**
>
> **`eventID 1` is a REAL user event** — published, `ccaID: 50`, and it holds a facility
> booking. It is **READ-ONLY for every part of this plan and every script in it: never modify
> it, never sweep it, never use it as a test row.**
>
> So `Event` is **not** empty, and three things that leaned on emptiness must be re-read:
>
> | Leaned on "0 rows" | Now |
> |---|---|
> | §0.1's row above | **stale.** Real count UNVERIFIED — could not measure (§0.0). |
> | D-49 / T-24 — "the embedded answers list lands on an empty collection, so the absent-key hazard has no legacy population" | **NO LONGER SAFE TO ASSUME.** `EventSignup` may hold real rows for `eventID 1`, each with **no `answers` key**. T-24 stops being theoretical the moment that is true, which is why §13.2 step 2 is BLOCKING and must run **before** PR 2 deploys. |
> | `schema.prisma:731-733` — the doc comment justifying nullable `Event.ccaID` with *"this collection had ZERO rows when the field was relaxed (measured 2026-08-26)"* | **contradicted by its own date.** The comment is stamped today and `eventID 1` exists today. Either the measurement predates the event or the claim is stale. Not this plan's to fix, but flagged: the comment uses "zero rows" as the safety argument for a nullable column, and that argument is weaker than it reads. |
>
> Note also that `EventQuestion` and `EventAttendance` **do not exist in `prisma/schema.prisma`
> at this commit at all** — the only references are the `tolerateAbsent: true` probes in
> `sweep-blank-event-drafts.mjs:438-439`. Whether the collections exist on the cluster is
> UNVERIFIED, but nothing on this branch would have created them.
>
> **`User.email_unique_ci` could not be confirmed present, and it is the one that matters
> most.** It is a collation index Prisma cannot represent, so it is invisible to the schema and
> is exactly what `prisma db push` silently drops (§9, Appendix A). It has been dropped and
> restored on this cluster before. **Do not run anything on the strength of an unverified
> assumption that it is there** — `index-census.mjs` exists to prove it, and it could not run
> today either.

### 0.2 What Phase 1 actually shipped

22 procedures in `src/server/api/routers/event.ts` (1,843 lines), verified by reading the
procedure-builder lines:

`create` `:428` · `update` `:528` · `submitForReview` `:635` · `withdraw` `:724` ·
`cancelEvent` `:790` · `reviewerCancel` `:867` · `duplicate` `:943` · `listForOwner` `:1023` ·
`getForOwner` `:1063` · `getSignupStats` `:1076` · `getAttendees` `:1119` ·
`exportAttendees` `:1155` · `listForReview` `:1196` · `getForReview` `:1225` · `decide` `:1261` ·
`listForOversight` `:1525` · `getForOversight` `:1618` · `listPublished` `:1661` ·
`getPublic` `:1694` · `signup` `:1741` · `cancelSignup` `:1802` · `listMySignups` `:1813`.

Six statuses; `editScope` exported from the shared schema and **imported** by the client
(`schemas/event.ts:71-83`, `EventManage.tsx:12`); `ownerLabel` in place
(`schemas/event.ts:384-390`); hall events at `/admin/events/hall/…`; the `withdraw`
transition; `reviewerCancel`; the audited PII export. All of that is correct and none of it
is touched by this plan except where named.

### 0.3 THE PHASE 1 DEFECT (Part A) — measured, and narrower than the brief says

The ruling was: *"head create events and the banner and the info and the signup questions all
stay there and then when he publishes it goes to review and once reviewed and accepted the
status changes to done."*

What shipped is **two screens**:

| # | Route | Component | Collects | Primary action |
|---|---|---|---|---|
| 1 | `/cca/[ccaID]/events/new` | `EventCreateForm.tsx` (141 lines) | title, description, start, end, location/facility, capacity | **Continue** (`:128`) |
| 2 | `/cca/[ccaID]/events/[eventID]` | `EventManage.tsx` → `DetailsEditor` (`:111-361`) | **all of the above, plus** banner, gallery, public description | **Submit for review** (`:354`) |

`createEventInput` (`src/lib/schemas/event.ts:244-258`) accepts `ccaID, title, description,
startTime, endTime, location, facilityID, capacity` — and **not** `bannerUrl`, `photoUrls` or
`publicDescription`. Read from the object; the brief's citation is correct.

The create form says so to the head's face, `EventCreateForm.tsx:117-121`:

> Fill in what you know now. You'll add the banner and the description residents see on the
> next screen, then submit it for review.

**Root cause.** Plan 01's D-14 kept `draft` as *"a TECHNICAL STAGING STATE"* because
`eventUploadPath(eventID, kind)` (`schemas/event.ts:162-164`) needs an `eventID` before a
banner can be uploaded. That constraint is real: `/api/event/upload/route.ts:68-74` loads the
Event row and throws `NO_SUCH_EVENT` when it is absent, and it needs `event.ccaID` at
`:78-88` to authorise the token at all. But the constraint decided the *product shape*, and
nobody caught it, because D-14 was written as a UI-hygiene decision ("a head is never parked
in draft") rather than as what it actually was: **a decision to split the authoring form in
two.** **D-14 is OVERRULED by D-28.**

### 0.4 Infrastructure this plan reuses rather than inventing

| Need | What already exists | Where |
|---|---|---|
| Create a unique index without `db push` | `createIndexes` via `$runCommandRaw`; dry-run default; idempotency-code map (48/68/85/86); VERIFY pass that re-reads `listIndexes` | `scripts/remediation/create-auth-allowlist.mjs` |
| Index census before/after | read-only; `EXPECTED` list at `:77-98`; guards `email_unique_ci` | `scripts/remediation/index-census.mjs` |
| Read-only assertion script | refuses `--commit`; `process.exitCode`, never `process.exit()` | `scripts/remediation/verify-events-schema.mjs` |
| Kill switch | `SystemFlag` row + 15s-TTL cached reader that fails CLOSED and does not cache failures | `services/events.ts:18-63`, `set-events-flag.mjs` |
| HMAC signing | `planSecret()` / `signRow()` / `tokenMatches()` — **pipe-joined** canonical payload, `createHmac("sha256")`, length-check-then-`timingSafeEqual` | `admin.ts:310-373` |
| Per-event serialisation | `withEventLock` — advisory doc lock on `EventLock.key`, 30s staleness reclaim, 50 × 100 ms retry | `services/events.ts:121-155` |
| Shared client/server zod | four files, **zero** Prisma or `~/server` imports, plain `useState` + `safeParse`; `react-hook-form` is installed but used nowhere in `src/app/**` | `src/lib/schemas/*.ts` |
| Per-field zod errors | `fieldErrorsFrom(error)` — first-wins, keyed on `issue.path[0]` | `src/app/admin/_lib/userDetail.ts:120-133` |
| Indexed array issue paths | `path: ["photoUrls", i]` inside a `superRefine` | `schemas/event.ts:309-318` |
| Dynamic-form precedent | server sends the field list, client renders it, server re-intersects against stored state | `completeProfileInput` (`schemas/profile.ts:157-183`) + `/onboarding/complete-profile/page.tsx` |
| Charts | `recharts ^2.12.7`, used directly, not through `ui/chart.tsx` | `EventAnalytics.tsx:3-13` |
| CSV | `csvField` (RFC-4180, quotes on `/[",\r\n]/`) · `serializeCsv` · `downloadTextFile` | `src/app/events/_lib/format.ts:115-145` |

**Nothing needs inventing for signing, locking, flagging, indexing, CSV or charts.** The two
genuinely new dependencies are in Part C (D-58).

---

## 0.9 CONTRADICTIONS — raised, not worked around

Twelve items where the brief and the code disagree, or where the code disagrees with itself.
**C-5 … C-15 are below; C-16 is stated at §3.6, where it belongs.**
Each records the finding and the ruling I am taking. Four of them (C-11 … C-14) are
pre-existing defects this plan found while grounding itself and did not create.

### C-5 — the live database could not be reached, so no premise about DATA was verified

In full at §0.0. **Ruling: proceed on carried-forward figures; §12.1 makes re-measuring them
BLOCKING.** If `Event` is no longer 0, D-30 and D-52 both need a second look and the coder
must stop and say so rather than proceeding.

### C-6 — the brief's `EventQuestion[eventID]` unique index is wrong

The brief says the new unique indexes are `EventAttendance[eventID,userID]` and
`EventQuestion[eventID]`. **A unique index on `eventID` alone permits exactly one
`EventQuestion` document per event**, which is the opposite of a form builder.

> **RULING: corrected.** `@@unique([eventID, questionID], map: "event_question")`.
> `EventAttendance` is as the brief says: `@@unique([eventID, userID], map:
> "event_attendee")`. **Two indexes, both compound-unique, and no others** — see D-45 and
> D-59: the unique index's leading `eventID` already serves every list query, and an index
> not created is an index that cannot be dropped by accident.

### C-7 — "no `db push`" and "Part C adds unique indexes" only *look* like a conflict

The repo has solved this once already. `create-auth-allowlist.mjs` creates a brand-new
collection and two unique indexes with one `createIndexes` command, dry-run by default,
verifying afterwards by re-reading `listIndexes`. `AuthAllowlist`'s two indexes exist today
by that route and by no other.

> **RULING: the same route.** One new script, `create-event-phase2-indexes.mjs`, modelled
> line for line on it. **No `db push`, no `migrate`, ever.** §9 is the whole procedure, with
> an index census before and after whose only acceptable delta is the two indexes this plan
> deliberately adds.

### C-8 — `EVENT_QR_SECRET` as a *required* env var contradicts two documented repo policies

The brief says *"a new required env var `EVENT_QR_SECRET`."* Two things argue against the
word *required*:

1. `src/env.js:39-44`, about `BLOB_READ_WRITE_TOKEN`, verbatim:
   > "OPTIONAL, unlike RESEND_API_KEY, and deliberately so: it is needed by exactly one
   > route, and making it required would stop the whole app building for any contributor who
   > has not pulled it. The upload route fails loudly on its own if the token is missing,
   > which localises the breakage to the feature that needs it."
2. `admin.ts:310-321` — `planSecret()` already answers "where does a signing secret come
   from" by reusing `NEXTAUTH_SECRET` and throwing `PLAN_TOKEN_SECRET_MISSING` when absent,
   with the comment *"Without a secret the token is unforgeable-by-nobody, which is worse
   than an outage."*

> **RULING: keep `EVENT_QR_SECRET` — the brief is explicit and a separate key is the better
> posture — but declare it `.optional()` in `src/env.js` and fail closed, loudly, at the one
> accessor (D-56).** "Required" is then true of the *feature* (the door refuses to open
> without it, and `event.attendanceStatus` reports *which* thing is missing) without being
> true of the *build*, which is the policy `env.js:39-44` states. **A human may overrule in
> one line** — either `z.string().min(32)` unconditionally, or drop the var and reuse
> `NEXTAUTH_SECRET` behind a `planSecret()`-shaped accessor. D-55's purpose string keeps the
> domains separate either way.

### C-9 — the Phase 1 defect is a redundant prelude, not a missing editor

Screen 2 **already is** the single authoring screen. `DetailsEditor` mounts
`EventDetailsFields`, `EventImageField`, `EventGalleryField` and the public-description
textarea in one form with one submit (`EventManage.tsx:268-360`). Screen 1 is a redundant
prelude. The fix is therefore **delete screen 1**, not **build a new editor**.

This matters operationally. A coder handed "build one authoring screen" may rewrite
`DetailsEditor` and lose the two non-obvious things it already gets right:

- the `onHandoff` escape hatch (`:120-129`) — trap T-16, *a message about a transition must
  be rendered by a component that survives the transition*;
- the fact that it is mounted **only** for `editScope === "all"` (`:926`), so the server's
  `EVENT_LOCKED` refusal is never shown to a head staring at a form.

> **RULING: delete screen 1. DO NOT REWRITE `DetailsEditor`.** D-28 through D-32.

### C-10 — `submitForReview` is NOT an atomic status write, contrary to constraint 5

Constraint 5 of the brief: *"Every status-changing write is `updateMany` scoped on the
expected status with a `count === 0` throw."* Commit `150113e` says *"make all five status
writes atomic, not just two."* There are **six** status writes in this router and the sixth
was not in the count.

`event.ts:657-668`:

```ts
await ctx.db.event.update({
  where: { eventID: input.eventID },
  data: { status: "submitted", decidedAt: null, decidedBy: null,
          decisionReason: null, updatedAt: new Date(), updatedBy: userID },
});
```

Bare `update`, keyed on `eventID` alone. The status check is at `:640-645`, one round trip
earlier, against the row `loadOwnedEvent` read at `:639`. Between the two, `cancelEvent` can
land — it is reachable from `draft` and `changes_requested` (`event.ts:797-803`), which are
exactly the two states `submitForReview` accepts. The result is `canceled → submitted`: a
**resurrected** event, back in the JCRC queue, that its owner believes they called off, with
no cancellation trace on the row and an `event.cancel` audit row that now describes something
that did not stick.

The same window admits `declined → submitted`, which is the race the shipped
`NOT_SUBMITTABLE` copy at `EventManage.tsx:72-81` already *describes* but which the write
does not actually refuse.

> **RULING: accepted, and fixed here (D-37).** It is a two-line edit inside a procedure Part
> A already touches, and shipping a plan whose §14 is about check-then-act while leaving a
> known check-then-act on a status column would be indefensible. The guard is spelled
> **negatively** — `NOT: { status: { in: ["submitted","published","declined","canceled"] } }`
> — for the same reason `cancelEvent` spells its guard negatively (`event.ts:812-816`):
> `normalizeStatus` maps null and anything unrecognised to `"draft"`, which IS submittable,
> so only the negative form matches the pre-check row for row.

### C-11 — `package.json` ships two npm scripts that will damage this cluster

```json
"db:generate": "prisma migrate dev",
"db:migrate": "prisma migrate deploy",
"db:push": "prisma db push",
"db:migrate-and-seed": "prisma migrate dev && prisma db seed",
```

`db:generate` does not run `prisma generate`. It runs `prisma migrate dev`. Every document
in this repo tells the operator to run `prisma generate`; the script named after it runs a
migration against MongoDB.

> **RULING: all four deleted (D-80).** `postinstall: prisma generate` stays — it is the one
> that is correct and it is what Vercel runs. This is a four-line edit that removes the
> shortest path to the incident this entire document is organised around.

### C-12 — `scripts/remediation/README.md` still instructs the operator to `prisma db push`

`README.md:19-27`, headed **"Step 0 — Create the new collections + indexes (REQUIRED)"**:

> "Push them so their **unique indexes** exist … `npx prisma db push`"

`set-events-flag.mjs:16-37` retracted exactly this instruction in its own header, in capitals,
with the reasoning. The README — the file an operator opens *first* — never got the same
treatment.

> **RULING: retracted the same way (D-81).** Step 0 is rewritten to name
> `create-auth-allowlist.mjs` and `create-event-phase2-indexes.mjs` as how indexes are made,
> with the prohibition **in the heading** rather than in a footnote. The retraction replaces
> the instruction; it is not appended to it, for the reason plan 01 §9.5 gives: *"an operator
> skimming a header for the command to run will run the command the header names."*

### C-13 — two more copies of the same stale instruction

`services/events.ts:9-11`:

```
 * Requires `prisma db push` so the unique indexes on `EventLock.key`,
 * `Counter.key` and `Event.eventID` exist — those indexes are what make the
 * lock, the counter and the id allocation safe.
```

and `schema.prisma:851-853` on `model EventLock`: *"`prisma db push` must create the unique
index on `key`."*

> **RULING: both corrected (D-81).** The *fact* is right — those indexes are what make the
> lock safe — and the *command* is wrong. Both become "created with `createIndexes`; see
> `scripts/remediation/create-event-phase2-indexes.mjs`, and never `db push` on this
> cluster."

### C-14 — `whats-new/page.tsx:385` already claims a feature that does not exist

Line 385, in the "At a glance → Events" column: **"Turnout stats for heads"**. There are no
turnout stats. `getSignupStats` (`R:1274-1314`) returns signups by day and by block —
who *registered*, never who *turned up*. Nothing in shipped code knows whether anyone attended
anything.

This is a live copy-drift instance that survived plan 01 §8.15, which audited `:231`, `:271`,
`:272`, `:292` and `:379` and never reached the "At a glance" column.

> **RULING: recorded as pre-existing, and made TRUE by Part D rather than deleted.** It is the
> seventh drift incident by the repo's own count and the honest thing is to say so. §11.6
> sequences the copy edit with the feature that makes it true, and §11.6 also states what to
> do if Part D slips: **delete the line**, do not leave it.

### C-15 — `whats-new/page.tsx:383` becomes false the moment questions exist

**"One-tap sign-up with fair limits"** — accurate today (`EventDetail.tsx:180-189` is one
button and one `signup.mutate({ eventID })`), and false for any event carrying a question.

> **RULING: rewritten in §11.6 as part of Part B, not left for later.** Copy that becomes
> false on the day a feature ships is the drift class this repo has paid for six times.

### C-16 — the brief names a `Profiles` model that does not exist

Stated in full at **§3.6**, beside the validator census it belongs to. Short version: constraint
9's list of validator-guarded models names `Profiles`; there is no `model Profiles` in
`schema.prisma`, and neither `CcaProfile` (`:544`) nor `ProfileCompletion` (`:900`) is
validated. **Ruling: harmless here — this plan adds no field to any guarded model — but §3.6's
eleven-name list is the one to check against.**

---

## 1. Decisions

Numbering continues from plan 01. **D-1…D-27 remain binding; D-14 is overruled by D-28.**

- Part A — the Phase 1 correction: **D-28 … D-38**
- Part B — Phase 2, custom signup questions: **D-39 … D-53**
- Part C — Phase 3, QR attendance: **D-54 … D-70**
- Part D — Phase 4, dashboards: **D-71 … D-77**
- Cross-cutting, rollout, hygiene: **D-78 … D-83**

**Added by the Part B reconciliation pass** (2026-08-26, against shipped Part A — read **B-0**
first). Lettered suffixes rather than new numbers, so every existing cross-reference in this
document and in plan 01 still resolves:

| # | Decision | Why it exists |
|---|---|---|
| **D-39a** | The blank-draft reuse branch must not return a draft that already has questions | `BLANK_EVENT_CONTENT` is `keyof Event`-typed and **structurally cannot** see a separate collection. **The highest-risk item in Part B.** |
| **D-39b** | Such a draft is neither reusable nor sweepable — the honest cost | Amends D-31's cap claim rather than letting it quietly become false |
| **D-40a** | The builder mounts inside `DetailsEditor`; **no new `page.tsx`** | Binding constraint 2, restated where it will actually be violated |
| **D-43a** | The already-signed-up check moves to the top of the lock, before validation | Reading the shipped code showed the drafted step order regresses retry idempotency |
| **D-45a** | `createEventInput` is untouched, and must never gain a `.default()` | zod defaults would silently make `isBareCreate` false forever — the `195b063` bug in a new disguise |
| **D-50a** | CSV injection: the correct file path, and the fix does **not** reach the roster export | The original claimed a second export was fixed for free; it is a different serialiser and is already immune |

---

## PART A — one screen, one primary action

### D-28 — D-14 IS OVERRULED. There is one authoring screen and no create screen.

`/cca/[ccaID]/events/new` and `/admin/events/hall/new` are **deleted**, and
`EventCreateForm.tsx` is **deleted with them**. The head's entire authoring surface is
`EventManage.tsx`'s `DetailsEditor`, which already collects every field (§0.3, C-9).

**Why D-14 was wrong, stated so it is not repeated.** D-14 said `draft` survives "for exactly
one reason: `eventUploadPath(eventID, kind)` needs an `eventID` before a banner can be
uploaded, so a row must exist first." That is a true statement about the *blob path*. D-14
then turned it into a statement about the *form*, and split the form in two. The row must
exist before the banner uploads; **the head does not have to be shown a screen while that
happens.** Those are different claims and the second does not follow from the first.

`draft` itself survives, unchanged, still labelled "Not submitted" (`format.ts:103`), still
the state a row is created in. What dies is the screen.

### D-29 — The row is created by the "New event" BUTTON, not by a route's `useEffect`

`EventsListPanel`'s "New event" affordance stops being a `<Link href={newHref}>`
(`EventsListPanel.tsx:67-72`) and becomes a mutation button:

```
click → event.create({ ccaID })   (no fields)
     → router.push(`${manageHrefBase}/${res.eventID}`)
```

**Why the button and not a `/new` route that creates on mount.** Three reasons, and the first
is a live hazard in this repo:

1. **React 18 StrictMode double-invokes effects in development** (`react ^18.3.1`,
   `next ^14.2.4`). A `useEffect(() => { create.mutate(...) }, [])` creates **two** events
   every time a developer opens the page. It behaves correctly in production, so it ships.
2. **The browser Back button re-enters the route** and creates a third. A mutation on mount
   has no idempotency key and no user gesture to bind to.
3. A click has a natural pending state (`Creating…`), a natural place to render an error
   (`NO_SUCH_CCA`, `NOT_A_HEAD_OF_THIS_CCA`, `EVENTS_DISABLED`,
   `CAPABILITY_REQUIRED:manageHallEvents` — all four already mapped in
   `EventCreateForm.tsx:90-100`, which move into `EventsListPanel` rather than being lost),
   and it fires exactly once per press.

`EventsListPanel` is already `"use client"` (`:1`), so this is a local change. **`newHref`
becomes unused and is removed from the prop type and from both callers** — leaving a dead
prop that names a deleted route is how a future reader resurrects it.

### D-30 — `create` REUSES the caller's existing blank draft instead of making a second one

`event.create` gains one step, before allocating an eventID:

```
if every content field in the input is absent (a bare create from the button):
  existing = findFirst({
    where: { ccaID: input.ccaID ?? null,      // EXPLICIT null — T-12
             createdBy: userID,
             status: "draft",
             title: null, description: null, publicDescription: null,
             bannerUrl: null, startTime: null, endTime: null,
             location: null, facilityID: null, capacity: null },
    orderBy: { createdAt: "desc" },
  })
  if (existing && existing.photoUrls.length === 0) return { eventID: existing.eventID }
```

**Why.** Create-on-click means every stray press of "New event" leaves a row behind. Without
this rule the number of abandoned blanks grows without bound; with it, **the maximum number
of live blank drafts is one per (owner scope, creator)** — press the button ten times and you
land on the same row ten times.

**Why the `photoUrls` check is in JS and not in the `where`.** Prisma+Mongo's `equals: []` on
a scalar list is a shape this repo has not used and does not need; the row is already in
hand. One list check in JS is cheaper than a query predicate nobody has tested.

**Why `createdBy` is in the filter.** A CCA with two heads must not have head B silently
adopt head A's abandoned blank — it would put B's edits on a row A believes is theirs, and
`createdBy` would then name the wrong person on the audit trail.

**Why `status: "draft"` and every content field are ALL in the filter, not just `status`.** A
row with a title is not blank; reusing it would silently discard whatever the head typed and
saved earlier. The filter is deliberately over-strict: the worst case of a *missed* reuse is
one extra blank row, and the worst case of a *wrong* reuse is lost work.

**The race is real and self-heals.** Two tabs pressing "New event" simultaneously both find
nothing and both create. That leaves two blanks, the next press reuses one of them, and D-33
sweeps the other. Serialising this behind a lock would be more machinery than the outcome
justifies.

**This does NOT apply when the input carries fields.** `duplicate` and any future
create-with-content path allocate a fresh id as they do today.

### D-31 — Abandoned blank drafts: the honest cost, and how the list handles them

Three consequences, none hidden:

1. **A burnt eventID.** `nextEventId` (`services/events.ts:82-102`) increments a counter; gaps
   are harmless and the counter never goes backwards. Nothing reads eventIDs as contiguous.
2. **A row in the owner's list.** It renders as `Untitled event` (`EventsListPanel.tsx:106`)
   with the badge "Not submitted". D-30 caps this at one per creator per scope.

   > **⚠ AMENDED BY PART B (D-39b). The "one per creator per scope" cap is narrowed.**
   >
   > D-39a stops the reuse branch handing back a blank draft that already carries
   > `EventQuestion` rows, and the sweep script's condition 7 already refuses to delete one. So
   > after Part B a draft with questions is **neither reusable nor sweepable**, and the real cap
   > reads: **one reusable blank draft, plus one row per abandoned question-building session.**
   > The second number is bounded by head behaviour and by nothing in the code.
   >
   > Accepted deliberately — the alternatives are destroying a head's authored questions, or
   > shipping the wrong form to the JCRC. See D-39b for the full argument. The sweep **reports**
   > these rows as skipped so the accumulation is visible.
3. **A possible orphaned blob.** *Pre-existing and unchanged*: `EventImageField.tsx:17-18`
   already says "Uploads on SELECT; abandoning the form leaves an orphaned blob (accepted,
   reconcilable by diffing `list()` against Event rows)." There is no reaper today — `list()`
   is never called anywhere in the repo — and this plan does not add one. Part A does not make
   this worse: a head who uploads a banner has, by definition, not abandoned a *blank* draft.

**The list does not hide them.** A row a head created must not vanish from the only list that
can reach it; that is how work is lost, and it is the same argument T-12 makes about
`listForOwner`'s `where`. Instead the blank row is rendered **honestly**, with a verb:

- a `draft` row with **no title** shows the sub-line **"Nothing filled in yet"** and the
  action line **"Start filling this in"** (rather than "Finish and submit", which is a lie
  about an empty row);
- a `draft` row **with** a title keeps today's **"Finish and submit"** (`:120-124`).

Verbatim strings in §11.1.

### D-32 — Nothing is deleted from the UI, and no delete path is added

D-21 stands: there is no hard delete reachable from the app. A head who wants a blank row gone
uses **Cancel event**, which already exists, is already terminal, and already writes one
`event.cancel` audit row. The confirm copy branches on status today (`EventManage.tsx:751-755`)
and gains a third, quieter variant for a blank draft (§11.1) — telling someone their signups
and room booking will be released, when the row has neither, is the copy-drift class §11 exists
to prevent.

### D-33 — A sweep script, and what it is and is not allowed to touch

`scripts/remediation/sweep-blank-event-drafts.mjs` — **dry run by default, `--commit` to act.**

It **deletes** an `Event` row only if **all** of these hold:

| # | Condition | Why |
|---|---|---|
| 1 | `normalizeStatus(status) === "draft"` | anything else has been acted on |
| 2 | `title`, `description`, `publicDescription`, `bannerUrl`, `location` all null-or-blank | nothing was typed |
| 3 | `startTime`, `endTime`, `facilityID`, `capacity` all null | nothing was chosen |
| 4 | `photoUrls.length === 0` | no gallery |
| 5 | `bookingID == null` | it holds no room |
| 6 | `EventSignup` count for this eventID is 0 | nobody signed up |
| 7 | `EventQuestion` count is 0 **and** `EventAttendance` count is 0 | no child rows anywhere |
| 8 | no `RoleAuditLog` row carries this `targetEventID` | nothing ever happened to it worth recording |
| 9 | `createdAt` older than **30 days** | not something a head is mid-way through |

**Why a hard delete is acceptable here when D-21 forbids one in the app.** D-21's argument was
about *a delete path over a counter-keyed collection reachable from the UI* — a new destructive
primitive with a button on it. This is a guarded remediation script that refuses anything with
a single byte of content, a single child row, or a single audit row. It is the **only** place
an `Event` row is ever removed, and it is not reachable from the application. The script header
must say exactly that, and must say that condition 8 is what makes the deletion invisible to
history rather than a hole in it.

**It must not touch the Counter.** Resetting `Counter.seq` after a delete would re-issue an
eventID that a blob path, a bookmark or an audit row may still name. `nextEventId` only ever
increments, and that is the property that keeps `event/{eventID}/banner` unambiguous.

**It is registered in `scripts/remediation/README.md`** (D-81) with the sentence "nobody runs
this automatically; run it when the events list gets noisy."

### D-34 — The ONE primary action is "Submit for review". "Publish" is rejected.

**The tension, stated plainly.** The user calls the head's action "publish": *"when he
publishes it goes to review."* It does not publish. It submits. A button labelled **Publish**
that does not publish would be the seventh copy-drift incident in this repo and the first one
to be a *button* — the highest-consequence string class there is, because a button is a
promise about what is about to happen.

**What is actually missing from the head's screen is not the word "publish".** It is the
sentence that closes the loop the head's mental model already contains: *once reviewed and
accepted the status changes to done.* Grep the head-facing authoring surface and that sentence
is nowhere. The nearest thing is `EventDetailsFields.tsx:206` — "If JCRC approves, this
facility is booked automatically" — which is about the room, not the event. The reviewer is
told (`EventReviewDetail.tsx:236-239`: "Approving publishes this event to the residents'
timeline straight away"); the head is not.

**Ruling.** The button stays **"Submit for review"**, and a one-line contract sentence goes
directly above the footer buttons stating what approval does and that it needs nothing further
from the head. Verbatim in §11.1.

**Why not change the verb to something like "Send for approval".** Because five other strings
on the same two surfaces already say review / queue / withdraw — `EventManage.tsx:977`
("Submitted — waiting for JCRC review."), `:980-982`, the `WithdrawButton` copy at `:599-605`,
`EventsListPanel.tsx:90`, `EventReviewQueue.tsx:52-54` — and a verb change that does not carry
all of them is drift arriving by a different door. The verb is not the gap. The missing promise
is.

**Hall events keep "Register and publish"** (`EventManage.tsx:508`), which is honest: on that
surface the action really does publish, because D-27 runs `submitForReview` then
`decide(approve)` back to back.

### D-35 — "Save and finish later" stays, as a SECONDARY action

One *primary* action does not mean one button. Removing the save would make the only way to
preserve work a submit — and with D-29 the head now lands on a **blank** editor, so the very
first thing they may want is to stop and come back. It stays as `variant="outline"`
(`EventManage.tsx:336-340`), left of the primary, exactly as today.

**No autosave.** `update` is deliberately unaudited (C-3), so an autosave would be *safe*, but
it is scope creep, it would fire on every keystroke against a Mongo cluster whose measured
round trip is ~2 s under load (`api/trpc/[trpc]/route.ts:33-53`), and it would break the
`saved` affordance at `:357`. Declined explicitly so nobody adds it as a kindness.

### D-36 — Every mechanism other than create-on-open was considered and rejected, in writing

| Mechanism | Why rejected |
|---|---|
| **Defer all writes to one submit** (no row until Save) | The blob path is `event/{eventID}/{kind}` and the upload route *loads the Event row* to authorise: `route.ts:68-74` throws `NO_SUCH_EVENT`, and `:78-88` needs `event.ccaID` to choose between `assertHeadsCca` and `manageHallEvents`. With no eventID there is nothing to load, so authorisation would have to fall back to a **client-supplied `ccaID`** — which this design refuses to trust by name (`loadOwnedEvent`'s comment, `event.ts:88-90`: *"The ccaID comes from the ROW, never the client"*). |
| **User-scoped temp blob path, re-keyed on create** | Everything above, **plus** five coordinated edits (`eventUploadPath`, `parseEventUploadPath`'s anchored regex, the route's load-and-branch, `isOwnEventBlobUrl` + `updateEventInput`'s `superRefine`, the `del()` cleanup at `event.ts:598-625`), **plus** a server-side copy inside a mutation that today cannot fail on I/O, **plus** a second orphan class in a store that has no reaper at all. This is the same trade D-19 already refused for `duplicate` (T-3), and refusing it there while accepting it here would be incoherent. |
| **Create on `useEffect` in a `/new` route** | StrictMode double-create in dev; Back-button re-entry in production. D-29. |
| **Keep both screens, move the three fields onto screen 1** | Does not satisfy the ruling — the banner still cannot upload before the row exists, so screen 1 would carry a banner field that cannot work. |

### D-37 — `submitForReview` becomes an atomic status write (ruling C-10)

`event.ts:657-668` becomes:

```ts
const applied = await ctx.db.event.updateMany({
  where: {
    eventID: input.eventID,
    // NEGATIVE, not a positive `in` list: normalizeStatus maps null and
    // anything unrecognised to "draft", which IS submittable, so only this
    // spelling matches the editScope check above row for row.
    NOT: { status: { in: ["submitted", "published", "declined", "canceled"] } },
  },
  data: { status: "submitted", decidedAt: null, decidedBy: null,
          decisionReason: null, updatedAt: new Date(), updatedBy: userID },
});
if (applied.count === 0) {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_SUBMITTABLE" });
}
```

The `findUnique` pre-check at `:639` **stays**: it separates `NO_SUCH_EVENT` from a bad
status, it supplies the row the audit write needs at `:670-678`, and it reports the ordinary
uncontended case. `NOT_SUBMITTABLE` is already in the client error map
(`EventManage.tsx:80-81`) with copy that is already correct for this case.

**This closes `canceled → submitted` and `declined → submitted`, neither of which is in plan
01 §2.1 because neither is supposed to exist.** With it, the count of atomic status writes in
this router is **six**, and the rule from T-15 is finally true without an exception:
*every write in this router that changes `status` puts the status it requires in the `where`.*

### D-38 — Part A ships alone, before Parts B/C/D, and needs no flag

Part A is a correction to a live feature with **zero production rows** (§0.1, unverified).
It adds no collection, no index, no capability, no env var and no flag. It deletes two routes
and one component and edits four files. It should be its own PR and its own deploy, and it
should land before anything in Part B is written, because Part B's question builder mounts
**inside** the screen Part A is fixing.

If Part A and Part B land together, the builder is built into a form that is about to move.

---

## PART B — Phase 2: custom signup questions

### B-0 — RECONCILIATION NOTICE: this Part was written BEFORE Part A shipped. Read this first.

**Status as of 2026-08-26.** Part A is implemented on branch `events-single-screen-authoring`
(commits `f8c9ffd`, `195b063`; PR #98, **UNMERGED**). This plan document was committed *inside*
`f8c9ffd` itself, which means **every `src/server/api/routers/event.ts` line number written into
Part B below was computed against the PRE-Part-A file** and is now stale by roughly +200 lines.
They have been rebased in place. This subsection records the rebase so a reviewer can tell a
correction from an error.

**A coder must re-verify any citation before trusting it.** `event.ts` is 2000+ lines and Part B
edits it heavily; the numbers below are correct against the working tree at the commit named
above and nothing else.

#### B-0.1 — Citation rebase table (Part B claims only)

`R` = `src/server/api/routers/event.ts`. `S` = `src/lib/schemas/event.ts`. Both were written as
bare "`event.ts`" in the original draft, which is ambiguous because **both files have a line
309**; they are disambiguated here and throughout.

| Claim | Was | **Now** | Note |
|---|---|---|---|
| `signup` procedure | `event.ts:1741` | **`R:1939`** | also gained `.use(requireMatric)` at `R:1940` |
| `signup` published/startTime guards | `:1747-1760` | **`R:1945-1959`** | unchanged behaviour |
| `signup` capacity check | `:1764-1781` | **`R:1961-1981`** | inside `withEventLock`, opened at `R:1961` |
| `signup` already-signed-up branch | `:1772-1779` | **`R:1966-1978`** | reached ONLY when capacity is full — see D-43a |
| `signup`'s `eventSignup.create` | — | **`R:1982-1985`** | the ONE write the answers ride on |
| P2002 swallow | — | **`R:1986-1997`** | T-23's whole subject |
| `getPublic` | `:1694` | **`R:1892`** | |
| `listPublished` | `:1661` / `:1686` | **`R:1859`** / **`R:1884`** | |
| `listMySignups` | `:1834` | **`R:2011`** | |
| `getForReview` | `:1225` | **`R:1423`** | |
| `getForOversight` redaction branch | `:1645-1656` | **`R:1842-1855`** | |
| `SCRC_HIDDEN_EVENT_FIELDS` | `:399` | **`R:403-411`** | unchanged; Part B adds nothing to it |
| `exportAttendees` | `:1155` | **`R:1353`** | |
| `exportAttendees` audit row | `:1183-1190` | **`R:1381-1388`** | `reason` at `R:1387` |
| `resolveAttendees` | `:190-250` | **`R:194-252`** | untouched by Part B |
| `toPublicCard` | `:270-298` | **`R:270-298`** | ✅ still correct |
| `create` | `:428` | **`R:472`** | |
| `create`'s explicit-null block | `:488-499` | **`R:610-640`** | `answersPurgedAt: null` at **`R:639`** |
| indexed zod issue `path` precedent | `event.ts:309-318` | **`S:309-318`** | it was always `schemas/`, not the router |
| `createEventInput` | `S:244-258` | **`S:244-258`** | ✅ still correct |
| `updateEventInput` rationale comment | `S:265-278` | **`S:265-278`** | ✅ still correct |
| `csvField` | `src/lib/format.ts:115-121` | **`src/app/events/_lib/format.ts:116-121`** | **wrong path** — see D-50a |
| `Event.startTime` epoch-seconds comment | `schema.prisma:748` | **`schema.prisma:753-754`** | |
| the I-2 deserialization quote | `schema.prisma:735-740` | **`schema.prisma:700`** | (siblings at `:529`, `:890`, `:1008`) |
| `EventSignup` live-PII-join comment | `schema.prisma:815-820` | **`schema.prisma:821-825`** | `model EventSignup` itself at **`:828`** |
| `Event.answersPurgedAt` | `schema.prisma:810` | **`schema.prisma:810`** | ✅ still correct |
| the ten legacy `type` blocks | `schema.prisma:11-76` | **`schema.prisma:11-76`** | ✅ still correct |
| lock staleness constant | `services/events.ts:108` | **`services/events.ts:110`** | `LOCK_STALE_MS = 30_000` |
| stale-lock reclaim | `services/events.ts:136-138` | **`services/events.ts:137-140`** | |
| `writeAudit` requires `actorUserID` | `admin.ts:406` | **`admin.ts:434-441`** | |
| `completeProfileInput` precedent | `schemas/profile.ts:157-183` | **`schemas/profile.ts:169-184`** | |
| `schemas/profile.ts` no-Prisma rule | `:3-10` | **`:3-10`** | ✅ still correct |
| `EventAttendees.tsx` CSV header build | `:31-40` | **`:31-40`** | ✅ still correct |
| `EventAttendees.tsx` pluralisation shape | `:66` | **`:66`** | ✅ still correct |
| `EventAttendees.tsx` export button / warning | `:74-75` / `:79-84` | **`:74-75`** / **`:79-84`** | ✅ still correct |
| second pluralisation precedent | `EventsListPanel.tsx:65` | **`EventsListPanel.tsx:114`** | `:65` is the `create` mutation |
| `EventDetail.tsx` "You're going" branch | `:147-163` | **`:147-163`** | ✅ still correct |
| `EventDetail.tsx` sign-up button branch | `:180-189` | **`:178-190`** | |
| `EventManage.tsx` `submitted` panel | `:951-989` | **`:1043-1078`** | |
| `EventManage.tsx` `DetailsEditor` | `:111-361` | **`:141-432`** | Submit button at **`:416`** |

**Scope of this rebase.** Every citation in **Part B and in the shared sections Part B relies on**
(§0, §3, §4, §5, §6.2, §7.3, §9, §11.2, §12.3, §13, and the Part B traps in §14) has been
corrected against the working tree. **Citations inside the Part C and Part D sections have NOT
been rebased** — this pass was scoped to Part B, and rewriting them would have meant re-verifying
attendance and dashboard code that has not been designed against yet. **They are stale by the
same ~+200 lines.** Eight known survivors, all Part C/D, at the time of writing:

```
event.ts:1191   event.ts:1802-1811   event.ts:1786-1797   event.ts:1117 (×2)
event.ts:1568-1577   event.ts:1268-1275   event.ts:1728-1738
```

**Whoever plans Part C must redo B-0.1 for those sections.** Do not treat a Part C/D `event.ts`
line number in this document as verified.

#### B-0.2 — What Part A shipped that Part B must now build ON, not around

| Shipped fact | Where | What it does to Part B |
|---|---|---|
| `/cca/[ccaID]/events/new`, `/admin/events/hall/new` and `EventCreateForm.tsx` are **DELETED** | `f8c9ffd` | The builder has exactly ONE mount point. D-46's "one screen" is now a fact, not a plan. |
| ONE authoring screen: `EventManage` → `DetailsEditor` | `EventManage.tsx:141-432` | **`EventManage.tsx:1` is `"use client"`.** The builder is a child of an existing client component — see D-40a. |
| "New event" is a mutation **button** | `EventsListPanel.tsx:63-69` | No route creates a row; nothing to hook. |
| `BLANK_EVENT_CONTENT` spread into the reuse `where` AND first into `create`'s `data` | `R:440-450`, `R:553-559`, `R:592-593` | **Part B breaks this. See D-39a — the single most important new decision in this pass.** |
| `isBareCreate` derived from `Object.entries(input)` | `R:531-533` | Safe for Part B *because Part B adds no field to `createEventInput`*. D-45a states the condition under which that stops being true. |
| `update` normalises `publicDescription` with `.trim() \|\| null` | `R:719-720` | Precedent: Part B's `label`/`helpText` trim in zod, not in the router. Already the case (D-41). |
| `submitForReview` is atomic (`updateMany` + `count === 0`) | `R:800-840` | C-10/D-37 are **done**. Part B adds no status write, so constraint 3 is satisfied vacuously — stated so no reviewer looks for a missing one. |
| The four dangerous `db:*` scripts are **gone**; only `db:studio` remains | `package.json` | C-11/D-80 are **done**. §9 is now the only way an index gets created. |
| `EventLock`'s doc comment already forward-references `create-event-phase2-indexes.mjs` | `schema.prisma:841-844` | **Part A shipped a reference to a script Part B must deliver.** §9.2 is not optional; the schema already promises it exists. |
| `sweep-blank-event-drafts.mjs` already refuses to delete a draft with `EventQuestion` rows | `sweep-blank-event-drafts.mjs:41`, `:438` | Condition 7. The sweep is already Part-B-aware; `create`'s reuse branch is **not**. That asymmetry is D-39a. |

#### B-0.3 — What this pass could NOT verify

Listed here rather than buried, because a previous pass carried figures forward as though
measured and a reviewer correctly called that blocking. See §0.0 and §12.1 — **every production
figure in §0.1 remains UNVERIFIED and must be re-measured before PR 2 ships.**

### D-39 — A new collection, `EventQuestion`. Questions never live on `Event`.

```prisma
model EventQuestion {
  id         String   @id @default(auto()) @map("_id") @db.ObjectId
  eventID    Int
  /// Per-EVENT, allocated as max+1 under withEventLock. NEVER REUSED — an
  /// answer references it, and reusing a deleted id would silently rebind an
  /// old answer to a new question.
  questionID Int
  /// Display order, 0-based, dense. Rewritten wholesale on every save.
  order      Int
  /// One of EVENT_QUESTION_TYPES (lib/schemas/eventQuestion.ts). A String, not
  /// an enum, for the same reason Event.status is: the DB cannot police it, so
  /// the router does.
  type       String
  label      String
  helpText   String?
  required   Boolean? @default(false)
  /// Non-empty ONLY for single_choice / multi_choice. [] for every other type.
  options    String[] @default([])
  /// Character cap for short_text / long_text. Null elsewhere.
  maxLength  Int?
  createdAt  DateTime? @default(now())

  @@unique([eventID, questionID], map: "event_question")
}
```

**Why a collection and not an embedded list on `Event`.** Three reasons:

1. `getForOversight` returns `{ ...event }` **unredacted** to a manager and
   `{ ...event, ...SCRC_HIDDEN_EVENT_FIELDS }` to the hall office (`R:1842-1855`).
   **Any new `Event` column leaks to the SCRC tier by default**, and the `satisfies` clause
   only catches typos, never omissions (T-18, T-30). A separate collection is unreachable from
   `oversightProcedure` because no oversight procedure queries it — the redaction problem does
   not arise rather than being solved.
2. Answers reference `questionID`. A stable, indexed, uniquely-constrained id is what stops an
   answer rebinding, and an embedded list has no unique index to give it one.
3. `Event` rows are read on the resident timeline (`listPublished`, `R:1859`) and on
   every head/review/oversight page. Questions are read on exactly one screen. Putting them on
   `Event` would add weight to the hottest read in the feature for the benefit of the coldest.

**No `@@index([eventID])`.** The `event_question` unique index leads with `eventID`, so
`findMany({ where: { eventID }, orderBy: { order: "asc" } })` is covered by its prefix. One
index, not two (C-6).

### D-39a — THE BLANK-DRAFT REUSE BRANCH MUST NOT HAND BACK A DRAFT THAT ALREADY HAS QUESTIONS

**This is the one place Part B actively breaks something Part A shipped, and it is silent.**
Nothing throws, nothing logs, `tsc` is clean, and the wrong outcome renders as a perfectly
normal screen. Read this before writing any other Part B code.

**The mechanism.** Part A's `create` (`R:472`) reuses the caller's existing blank draft rather
than allocating a new id (D-30). "Blank" is defined by `BLANK_EVENT_CONTENT` (`R:440-450`),
spread into the reuse `where` at `R:558` and first into `create`'s `data` at `R:593`. Its type is:

```ts
} as const satisfies Partial<Record<keyof Event, null>>;
```

**`keyof Event`.** Questions are a separate collection (D-39) with no relation field on `Event`,
so **"has no questions" is not expressible in `BLANK_EVENT_CONTENT` at all** — not by oversight,
but by construction. The `satisfies` guard that makes the filter safe against renamed columns is
the same guard that makes it blind to anything not a column.

**The outcome, step by step:**

1. Head presses **New event** → `create` allocates eventID 42, a `draft` with every content
   field null.
2. Head lands on `EventManage`, scrolls past the details, and builds six signup questions.
   `saveQuestions` writes six `EventQuestion` rows against eventID 42. **It touches no `Event`
   column** — correctly, per D-39 and D-53.
3. Head never types a title, and leaves.
4. Head returns another day and presses **New event**. `isBareCreate` is true. The reuse filter
   matches: every `BLANK_EVENT_CONTENT` key is still null and `photoUrls` is still empty.
5. `create` returns `{ eventID: 42 }`. **The head is now looking at a screen they believe is a
   brand-new event, carrying six questions they wrote for a different one.**

**How bad, honestly.** `createdBy: userID` is in the reuse filter (`R:546`), so the resurrected
draft is always the caller's **own** abandoned work — this is not one head inheriting another
head's questions, and the plan should not be read as claiming that. The real damage is narrower
and still real: the details editor is at the top of the screen and the builder is below it, so a
head who fills in the details and presses **Submit for review** without scrolling ships a form
they did not write this time. **The JCRC then approves those questions** (D-47), and once the
event publishes and one resident signs up, D-44 **freezes them**. The cheapest correction at that
point is cancel-and-duplicate.

> **RULING.** The reuse branch gains a question count, checked in JS after the row is in hand,
> exactly mirroring the `photoUrls` check Part A already put there for the same class of reason.

```ts
// R:566 today:
//   if (existing && existing.photoUrls.length === 0) {
//     return { eventID: existing.eventID };
//   }
// becomes:
if (existing && existing.photoUrls.length === 0) {
  // D-39a — A DRAFT THAT ALREADY CARRIES QUESTIONS IS NOT BLANK.
  //
  // This CANNOT go in the `where` above. BLANK_EVENT_CONTENT is
  // `satisfies Partial<Record<keyof Event, null>>` and questions are a
  // separate collection with no relation field on Event, so blankness as
  // spelled there is structurally incapable of seeing them. Checked here, in
  // JS, for the same reason photoUrls is: the row is already in hand.
  //
  // FALL THROUGH rather than deleting the questions. Silently discarding a
  // head's work to keep a draft-count invariant tidy is the worse trade; the
  // cost of falling through is one extra abandoned row (D-39b).
  const questionCount = await ctx.db.eventQuestion.count({
    where: { eventID: existing.eventID },
  });
  if (questionCount === 0) {
    // RETURNS BEFORE nextEventId — unchanged from Part A.
    return { eventID: existing.eventID };
  }
}
```

**Why not delete the questions on reuse.** Because the head may be coming back *to* those
questions. Reuse exists to cap abandoned rows, which is a housekeeping goal; it must never
outrank not-destroying-work. Falling through costs one counter value.

**Why not add a relation field to `Event`.** Two independent refusals. It would be a **new
`Event` column**, which is an SCRC disclosure decision every time (T-30) and would force a
`SCRC_HIDDEN_EVENT_FIELDS` review that D-47 currently gets to skip. And a Prisma relation is not
`null`, so it could not satisfy `Partial<Record<keyof Event, null>>` — the guard would have to be
loosened for every field to admit one.

**Cost of the extra query.** One `count` on `EventQuestion`, on the `event_question` index's
leading `eventID` prefix, on the bare-create path only — a path a head hits by pressing a button,
not a hot read. Note it **runs only inside the `isBareCreate` branch and only when a candidate row
was actually found**, so the common "no blank draft exists" case is unchanged.

**This is one of the two things §13.3 says MUST be checked in a browser.** A unit test cannot
reach it: it needs a real row, abandoned, with real question rows, and a second button press.

### D-39b — The honest cost: a draft with questions is neither reusable NOR sweepable

D-39a's fall-through and the sweep script's existing condition 7 point the same way, and together
they leave a gap that must be written down rather than discovered.

`sweep-blank-event-drafts.mjs` — which **Part A already shipped** — refuses to delete any draft
with `EventQuestion` rows (`sweep-blank-event-drafts.mjs:41` declares condition 7,
`:438` implements it, and `:103-111` explains the deliberate tolerance for the collection not
existing yet). It was written Part-B-aware. `create`'s reuse branch was not. After D-39a, both
agree, and the consequence is:

**A blank draft carrying questions is not reused (D-39a) and not swept (condition 7). It stays
until a human deletes it.**

> **D-31'S CAP CLAIM IS NARROWED BY THIS, AND D-31 IS AMENDED TO SAY SO.** Part A states the
> number of live blank drafts caps at **one per (owner scope, creator)**. After Part B that reads:
> **one reusable blank draft, plus one row per abandoned question-building session.** The second
> number is bounded by head behaviour and by nothing in the code.

**Accepted, not solved, and here is why.** The alternatives are worse in the direction that
matters: sweeping such a draft destroys authored questions with no undo, and reusing it ships the
wrong form to the JCRC. Leaving a row costs one document. The sweep script **reports** these rows
as skipped with the condition that blocked them, so the operator can see the accumulation and
delete deliberately — which is the correct place for that judgement.

**The sweep script needs no code change for Part B.** Stated as a line item so no coder "fixes"
condition 7 into a deletion. Its only Part B edit is the one D-81 already schedules for its
header text.

`src/lib/schemas/eventQuestion.ts` — a **new file**, not an addition to `event.ts` (already
400 lines, and the repo keeps one schema module per feature area: `cca.ts`,
`ccaApplication.ts`, `event.ts`, `profile.ts`).

```ts
export const EVENT_QUESTION_TYPES = [
  "short_text", "long_text", "single_choice", "multi_choice",
  "checkbox", "number", "date",
] as const;
export type EventQuestionType = (typeof EVENT_QUESTION_TYPES)[number];
```

`as const` string tuple, **never** imported from `@prisma/client` — `src/lib/schemas/` has
zero Prisma imports today (verified: the only imports across all four files are `zod` and
`~/lib/identity`), and that is the rule stated verbatim at `schemas/profile.ts:3-10` and
repeated at `event.ts:5-11`. A `"use client"` component value-importing from the server tree
risks pulling Prisma into the browser bundle.

Caps live beside them: `EVENT_MAX_QUESTIONS = 20`, `EVENT_QUESTION_LABEL_MAX = 200`,
`EVENT_QUESTION_HELP_MAX = 300`, `EVENT_MAX_OPTIONS = 20`, `EVENT_OPTION_LABEL_MAX = 120`,
`EVENT_ANSWER_TEXT_MAX = 2000` (the hard ceiling a `maxLength` may not exceed),
`EVENT_ANSWER_DEFAULT_MAXLENGTH = 200`.

**Why 20 questions and 20 options.** Arbitrary, and stated as arbitrary. They exist so a
crafted payload cannot make one signup document unbounded, and so the CSV export cannot grow
a hundred columns. Change them here, in one place, if a real event needs more.

### D-40a — WHERE THE BUILDER MOUNTS, AND THE ONE RULE THAT KILLED FIVE ROUTES

Restating **binding constraint 2** at the exact place a coder is about to violate it.

> **A SERVER COMPONENT MUST NEVER PASS A FUNCTION PROP TO A CLIENT COMPONENT.** It is not a
> type error, ESLint does not see it, and it survives `next build`. It 500s the route at
> request time. It has already taken out all five authoring routes in this feature once, past
> `tsc`, lint, a green build and two review agents (T-19). The builder is the most interactive
> thing in the plan, so this is live risk, not a historical note.

**What Part A leaves us, and why it is safe.** After `f8c9ffd` there is exactly one authoring
screen. Its mount points are server components that pass **only serialisable props**:

```tsx
// src/app/cca/[ccaID]/events/[eventID]/page.tsx:14-30  (a server component)
<EventManage
  ccaID={ccaID}                                  // number
  eventID={eventID}                              // number
  backHref={`/cca/${ccaID}/events`}              // string
  manageHrefBase={`/cca/${ccaID}/events`}        // string
/>
```

and the hall-wide counterpart `src/app/admin/events/hall/[eventID]/page.tsx:25` does the same
with `ccaID={null}`. **`EventManage.tsx:1` is `"use client"`**, so everything below it —
`DetailsEditor` (`EventManage.tsx:141-432`) included — is already client code.

> **RULING. `EventQuestionBuilder` mounts INSIDE `DetailsEditor`, as an ordinary child of an
> existing client component. It gets NO route of its own, NO `page.tsx`, and NO new
> server/client boundary.** That is the whole reason constraint 2 is satisfiable here without
> care: there is no boundary left to cross.

**The failure mode to refuse, spelled out** — because "put the builder on its own tab/page"
is a natural instinct and it is the trap:

```tsx
// src/app/cca/[ccaID]/events/[eventID]/questions/page.tsx   ← DO NOT CREATE THIS FILE
export default function QuestionsPage({ params }) {          //   server component by default
  return <EventQuestionBuilder onSave={(qs) => save(qs)} />;  //   ← 500s the route. Every time.
}
```

If a later phase genuinely needs a separate route, the page passes **`eventID` and strings
only**, and the component owns its own mutation hook — the shape every existing route already
uses. **A new `page.tsx` under `src/app/` is, by itself, reason enough for a reviewer to stop
and check this.**

**Where in `DetailsEditor`.** Below the public description and the gallery, above the footer
actions (`EventManage.tsx:401-416`), so the head reads the contract sentence at
`EventManage.tsx:385` and the primary action **after** the questions rather than before them.

### D-41 — ONE zod schema shared by client and server, PLUS one shared validator function

Two things are shared, and they are different things. Conflating them is how this goes wrong.

**(a) The payload SHAPE — a static zod schema, `safeParse`d on both sides.**

```ts
export const questionDraftSchema = z.object({
  questionID: z.number().int().positive().nullable(),   // null = a NEW question
  type: z.enum(EVENT_QUESTION_TYPES),
  label: z.string().trim().min(1, "Every question needs a label").max(EVENT_QUESTION_LABEL_MAX),
  helpText: z.string().trim().max(EVENT_QUESTION_HELP_MAX).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(EVENT_OPTION_LABEL_MAX)).max(EVENT_MAX_OPTIONS).optional(),
  maxLength: z.number().int().positive().max(EVENT_ANSWER_TEXT_MAX).nullable().optional(),
}).superRefine((q, ctx) => {
  const needsOptions = q.type === "single_choice" || q.type === "multi_choice";
  if (needsOptions && (q.options ?? []).length < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"],
      message: "A choice question needs at least two options" });
  }
  if (!needsOptions && (q.options ?? []).length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options"],
      message: "Only choice questions have options" });
  }
  if (needsOptions) {
    const seen = new Set<string>();
    (q.options ?? []).forEach((o, i) => {
      const k = o.toLowerCase();
      if (seen.has(k)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["options", i],
          message: "Two options can't be the same" });
      }
      seen.add(k);
    });
  }
  const isText = q.type === "short_text" || q.type === "long_text";
  if (!isText && q.maxLength != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["maxLength"],
      message: "Only text questions have a length limit" });
  }
});

export const saveQuestionsInput = z.object({
  eventID: z.number().int().positive(),
  questions: z.array(questionDraftSchema).max(EVENT_MAX_QUESTIONS),
});
```

The indexed `path: ["options", i]` is the shape `S:309-318` already uses for
`photoUrls`, and it is what lets the builder show an error on the right row.

**(b) The ANSWER CONTENT — a pure function, `validateAnswers`, not a runtime-built schema.**

```ts
export type EventAnswerValue = { questionID: number; values: string[] };

export function validateAnswers(
  questions: readonly QuestionForValidation[],
  answers: readonly EventAnswerValue[],
): { ok: true; normalized: EventAnswerValue[] }
 | { ok: false; errors: Record<number, string> };   // keyed by questionID
```

**Why a function and not a zod schema built at runtime.** Four reasons:

1. **The repo has never built a schema at runtime.** Grep for `z.record`, `z.lazy`,
   `z.any`, `.catchall`, `.passthrough` across `src/` returns **zero hits**. Introducing the
   pattern for one feature is a new thing to maintain.
2. **The client does not know the authoritative question list.** It knows what it fetched,
   which a co-head may have changed since. A client-built schema validates against questions
   that may no longer exist. This is the identical argument `updateEventInput` already makes
   for not encoding the per-status field subset (`schemas/event.ts:265-278`), and the
   identical posture `completeProfileInput` takes (`schemas/profile.ts:169-184`): permissive
   payload schema, server re-intersects against stored state.
3. **Errors need to be keyed by `questionID`, not by array index.** A `Record<number, string>`
   renders directly under the right field; a zod issue path over a sparse array does not.
4. Both sides import the *same function*, so "the client mirrors the server" is enforced by
   the module system, which is the property `schemas/profile.ts:3-10` exists to buy.

**The client still runs a real `safeParse`** — on `signupInput` (D-43) for shape, and then
`validateAnswers` for content. Both live in `src/lib/schemas/`. The server runs the same two,
against the **stored** questions.

### D-42 — Answer serialisation: ONE field, `values: string[]`, with the rules written once

Every answer is a `string[]`. The canonical rules live in `eventQuestion.ts` beside the type
list and nowhere else:

| Type | `values` | Empty means |
|---|---|---|
| `short_text`, `long_text` | `[text]` | `[]` |
| `single_choice` | `[chosenOption]` — must be one of `options` | `[]` |
| `multi_choice` | `[a, b, …]` — every entry must be in `options`, no duplicates | `[]` |
| `checkbox` | `["yes"]` when ticked | `[]` when not |
| `number` | `[String(n)]`, where `n` parses as a finite number | `[]` |
| `date` | `["YYYY-MM-DD"]` — a **calendar date only**, no time, no zone | `[]` |

**Why one string list rather than typed columns.** A composite type with `text?`,
`number?`, `choices[]` would have three ways to spell an empty answer and would need a
discriminated read at every consumer. One list has one empty value (`[]`) and one CSV
serialisation (`values.join("; ")`).

**Why `date` is a calendar date and not an epoch.** `Event.startTime` is epoch **seconds**
(`schema.prisma:753-754`) because it names an instant. A question like "which day can you make?"
names a *date*, and storing it as an instant makes it shift across timezones — the answer a
resident typed on 3 March reads back as 2 March for a reader an hour west. Every other date
in this repo is an instant; this one deliberately is not, and the schema comment must say so.

**Required means non-empty.** `required: true` + `values.length === 0` is the one universal
error, message in §11.2.

### D-43 — `event.signup` gains `answers`, validated and written INSIDE `withEventLock`

`signup` (**`R:1939`**) input becomes — note it currently takes the shared `eventIdInput`
(`R:1941`) and carries `.use(requireMatric)` (`R:1940`), which **stays**:

```ts
export const eventSignupInput = z.object({
  eventID: z.number().int().positive(),
  answers: z.array(answerValueSchema).max(EVENT_MAX_QUESTIONS).optional(),
});
```

Permissive by design (D-41 reason 2). The procedure:

```
1. assertEventsEnabled
2. event = findUnique(...) ; must be published ; startTime not passed   [unchanged, R:1945-1959]
3. return withEventLock(db, eventID, async () => {
     3a. already = await db.eventSignup.findUnique({
           where: { eventID_userID: { eventID, userID } }, select: { eventID: true },
         })
         if (already) return { signedUp: true as const }   // D-43a — BEFORE validation
     3b. questions = await db.eventQuestion.findMany({ where: { eventID }, orderBy: { order: "asc" } })
         // INSIDE the lock, so a head cannot slip a question in between the
         // validation and the write. The freeze (D-44) makes this near-vacuous
         // once one signup exists; for the FIRST signup it is the only guard.
     3c. const v = validateAnswers(questions, input.answers ?? []);
         if (!v.ok) throw BAD_REQUEST "ANSWERS_INVALID"   // detail in `cause`, §11.2
     3d. capacity check                                   [R:1961-1981, SIMPLIFIED — see D-43a]
     3e. await db.eventSignup.create({
           data: { eventID, userID, createdAt: new Date(), answers: v.normalized },
         })                                               // ONE document, ONE write
         // P2002 -> idempotent success, EXACTLY as today. See T-23.
   })
```

**The answers ride on the existing `create`.** There is no second write. Read mistake ④.

### D-43a — THE ALREADY-SIGNED-UP CHECK MOVES TO THE TOP OF THE LOCK

The original draft of D-43 put answer validation at step 3b, **before** the already-signed-up
early return. Reading the shipped code shows that ordering is wrong, in a way that only bites a
retry — so it would have passed every happy-path test.

**What the shipped code actually does.** There are **two** idempotent paths today, not one, and
the plan's `:1772-1779` citation only ever described the first:

| Situation | Path today | Result |
|---|---|---|
| already signed up, event **full** | explicit `findUnique` + early return, **`R:1966-1978`** | `{ signedUp: true }` |
| already signed up, event **not full** | falls through to `create` → **P2002** → swallowed at **`R:1986-1997`** | `{ signedUp: true }` |

Both succeed. The explicit branch exists only *inside the capacity-full arm*; the ordinary case
is idempotent by exception.

**What validating first would break.** Both paths would now have to produce valid answers before
reaching their early return. A retry that carries **no** answers — a stale tab, a re-fired
mutation after a network blip, any client that resends `{ eventID }` alone — would get
`ANSWERS_INVALID` on an event the resident is **already signed up for**. Today that returns
success. It is a regression, it is only reachable on a retry, and the user-visible symptom is an
error message about a form they already submitted.

It is also **wasted work**: D-43 rules that an already-signed-up caller's stored answers are left
alone, so the payload being validated is discarded either way.

> **RULING.** One `findUnique` on the `event_user` index at the top of the lock, returning
> `{ signedUp: true }` immediately. Validation and the capacity check both sit after it.

**What this buys, beyond fixing the regression:**

1. **"First answer wins" becomes true by construction** rather than by falling through to a
   P2002 swallow. D-48 point 2 (no answer editing) is then enforced by the shape of the
   procedure, not by an exception handler's side effect.
2. **The capacity-full arm gets simpler.** Its inner `findUnique` at `R:1968-1975` and its early
   return at `R:1977` are now dead — the caller cannot reach that arm while already signed up.
   Delete them; the arm reduces to `if (count >= capacity) throw CONFLICT "EVENT_FULL"`.
3. **T-23 is unaffected.** The P2002 swallow at `R:1986-1997` **stays exactly as it is**. It is
   the genuine-race backstop — two tabs both passing step 3a — and D-43a does not replace it.
   **Do not delete the catch.**

**Cost.** One indexed `findUnique` on every signup, on a path that already does a `count`
against the same collection inside the same lock.

**The copy must not promise otherwise** (§11.2), and there is deliberately **no** "edit my
answers" path in this phase (D-48).

### D-44 — Questions freeze on the first signup, AND respect `editScope`

One helper, called by every question mutation:

```ts
// services/events.ts
async function assertQuestionsEditable(db, event): Promise<void> {
  if (editScope(normalizeStatus(event.status)) === "none") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "EVENT_LOCKED" });
  }
  const signups = await db.eventSignup.count({ where: { eventID: event.eventID } });
  if (signups > 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "QUESTIONS_FROZEN" });
  }
}
```

**Two conditions, and they are different facts.**

- `editScope === "none"` covers `submitted`, `declined`, `canceled`. **`submitted` matters
  most**: the questions are part of the event the JCRC reviews (D-47), and an event in the
  queue is frozen so the reviewer never approves a form that changed underneath them. It is
  the same rule, from the same imported function, as every other field.
- `published` has `editScope === "public"`, which is **not** `"none"` — so a live event with
  zero signups can still gain a question. That is deliberate: questions only ever matter once
  an event is published and open, so freezing them at publish would mean they could never be
  added at all.
- **Zero signups** is the real freeze. Editing a live form silently invalidates existing
  answers: a deleted question orphans its answers, a renamed option makes a stored
  `single_choice` value refer to something that no longer exists, and a newly-`required`
  question makes every existing signup retroactively incomplete with no way to ask anyone.

**The count is read INSIDE `withEventLock`** in the mutation (D-45), so "no signups yet" and
"write the questions" cannot interleave with a signup.

### D-45 — `event.saveQuestions` — one whole-list save, under the lock, with never-reused ids

There is no per-question add / edit / delete / reorder mutation. **One mutation takes the
whole list**, in order, and reconciles.

```
saveQuestions: identifiedProcedure.input(saveQuestionsInput).mutation:
  1. assertEventsEnabled
  2. roles = live getUserRoles                                  // I-5
  3. event = await loadOwnedEvent(db, userID, roles, eventID)   // the ONLY ownership branch
  4. return withEventLock(db, eventID, async () => {
       4a. await assertQuestionsEditable(db, event)             // D-44, inside the lock
       4b. existing = findMany({ where: { eventID } })
       4c. maxID = max(existing.questionID, 0)
       4d. for each incoming question, in array order (index = `order`):
             questionID == null  -> allocate ++maxID
             questionID != null  -> it MUST be in `existing`, else BAD_REQUEST
                                    "NO_SUCH_QUESTION"
       4e. deleteMany({ eventID, questionID: { notIn: keptIDs } })
       4f. upsert each by { eventID_questionID }, writing EVERY field explicitly
           (options: [] and maxLength: null when the type has none — T-12)
     })
  5. no audit row  (C-3: this is a field save, not a state-machine transition)
```

**Why whole-list.** Reordering is the operation a builder does most, and a per-question
`order` patch is N writes that can half-apply. One list, one reconciliation, one lock.

**Why ids are never reused.** `maxID` is the max of what currently exists **plus** whatever
this call allocates; a deleted question's id is not recycled. If it were, an answer stored
against question 3 would silently rebind to a different question 3 the moment one was
re-added — the answers are on a different document and nothing would flag it.

**The unique index is the backstop, not the mechanism.** The lock is advisory: `EventLock`
rows are reclaimed after 30 s of staleness (`services/events.ts:110,137-140`), so a pathological
pause can produce two holders. `@@unique([eventID, questionID])` is what turns that into a
`P2002` instead of a duplicate id — and it **only exists if `createIndexes` ran** (mistake ②).

**Why `withEventLock` and not a new lock.** It is keyed `event:{eventID}` and it already
serialises signup. Sharing it means a question save and a signup **cannot** interleave, which
is precisely the guarantee D-44 needs. The cost is T-38: a question save can wait up to 5 s
behind a burst of signups. Acceptable — a head editing a form is not on a hot path.

### D-45a — `createEventInput` IS NOT TOUCHED, AND `isBareCreate` STILL BEHAVES. Verified, with the condition that would break it.

Part A rewrote `isBareCreate` (`R:531-533`) to derive blankness **from the parsed input object**
rather than from a hand-written field list, and the comment above it (`R:520-530`) names
*"Phase 2's question rows"* as the exact future field it was hardened against. That hardening is
now checked against what Part B actually does.

```ts
const isBareCreate = Object.entries(input).every(
  ([key, value]) => key === "ccaID" || value == null,
);
```

**Part B adds NO field to `createEventInput`.** Questions are written by `saveQuestions` (D-45),
a separate mutation, against an event that already exists — an event has to exist before it can
have questions, so there was never a reason to carry them on create. `createEventInput`
(`S:244-258`) is unchanged, and §5.1's table already records it as unchanged. **`isBareCreate` is
therefore correct as shipped and needs no edit.**

**Verified, not assumed —** the derivation is only safe because of a property of the schema that
nothing states, so it is stated here:

- Every field of `createEventInput` is `.optional()` (`S:246-256`). A field the caller **omits is
  absent from the parsed object entirely**, so it never appears in `Object.entries(input)` and
  cannot make `every` false. A field present-but-null passes `value == null`. Both cases work.
- **There is no `.default()` anywhere in `src/lib/schemas/event.ts`** — grepped, zero hits.

> **THE ONE CHANGE THAT WOULD SILENTLY BREAK IT: adding a `.default()` to `createEventInput`.**
>
> zod **populates** a defaulted field in its output even when the caller omitted it. A
> `questions: z.array(...).default([])` would put `questions: []` into every parsed payload;
> `[] == null` is false; **`isBareCreate` would be false for every bare create, forever.** Reuse
> would then never fire, every press of "New event" would allocate a fresh id, and the unbounded
> blank-draft outcome D-30 exists to prevent would come straight back — **with no error, a green
> build, and a passing test suite.** That is precisely the bug `195b063` was written to fix, in
> a new disguise.
>
> **Rule for any future phase: fields on `createEventInput` are `.optional()`, never
> `.default()`.** If a default is genuinely needed, apply it in the router after the reuse
> branch, not in the schema. §13.1 carries this as a static check.

### D-46 — `event.getQuestionsForOwner` and the resident's read path

| Procedure | Builder | Returns | Notes |
|---|---|---|---|
| `getQuestionsForOwner` | `identifiedProcedure` + `loadOwnedEvent` | the full list **plus** `frozen: boolean` and `signupCount` | `frozen` is computed server-side from the same two conditions as D-44 so the UI cannot re-derive it wrongly |
| `getPublic` (existing, `:1694`) | `protectedProcedure` | **gains `questions`** | see below |

**`questions` is added to `getPublic`'s return and NOT to `toPublicCard`.** `toPublicCard`
(`R:270-298`) is shared by `listPublished` (`R:1884`) and `listMySignups` (`R:2011`), so
putting questions there would ship every event's whole form to the timeline on every page
load. `getPublic` is a single-event fetch and is the only place the form is rendered.

**What the resident sees of a question:** `questionID`, `order`, `type`, `label`, `helpText`,
`required`, `options`, `maxLength`. That is the whole row minus `id`, `eventID` and
`createdAt` — there is no PII and no canonical id on this model at all, which is why it needs
no redaction list.

### D-47 — The JCRC reviews the questions; the SCRC never sees the answers

**Reviewer.** `getForReview` (`R:1423`) gains the question list, and
`EventReviewDetail` renders it read-only above the decision buttons. A reviewer approving an
event is approving what residents will be asked — including, per D-51, whether the head has
put a health question on a hall form. Approving without seeing the questions would make the
PDPA line in D-51 advisory only.

**SCRC.** No oversight procedure reads `EventQuestion` or `EventSignup.answers`, so neither is
reachable from `oversightProcedure` and **`SCRC_HIDDEN_EVENT_FIELDS` needs no change.** That
is stated here as a deliberate line item, not an omission: this plan adds **no new column to
`model Event`**, so the redaction list is complete as it stands. §7.3 restates it. The moment
any future phase adds an `Event` column, T-30 applies again.

**Answers.** Reachable by the owning head only, through `getAttendees` / `exportAttendees` /
`getSignupAnswers`, all of which go through `loadOwnedEvent`. The permitted ceiling is head +
JCRC; **the JCRC gets no answers screen in this phase** (D-48).

### D-48 — Three things Part B deliberately does not build

1. **A JCRC answers view.** The access ceiling is head + JCRC, but a ceiling is not a mandate.
   Every screen that returns answers is a new PII disclosure surface over a per-person free-text
   field, and the JCRC has stated no use for one. If it is wanted later it is one procedure on
   `roleManagerProcedure` with a live `reviewEvents` re-check **and an audit row**, in the class
   of `event.attendees.export`.
2. **Editing your own answers after signing up.** It would need a second write path into a
   document whose only write is inside the capacity lock, and it reopens "which answer counts"
   the moment a purge or an export has already read them. The resident cancels and signs up
   again, which is one click each way (`EventDetail.tsx:152-162`, `:180-189`) and leaves a
   correct, single, current answer.
3. **File-upload answers.** A new blob namespace, a new orphan class, a new virus surface and a
   new retention problem, for a form on a hall event. No.

### D-49 — Answers are an embedded composite list on `EventSignup`

```prisma
/// One answer to one EventQuestion. Embedded on EventSignup so the answer and
/// the signup are ONE document: the capacity check, the signup row and the
/// answers are then a single write inside withEventLock and cannot half-apply.
///
/// `values` is ALWAYS a string list — see EVENT_QUESTION_TYPES in
/// lib/schemas/eventQuestion.ts for the serialisation of each type, which is
/// defined THERE and nowhere else. An unanswered optional question is [].
type EventAnswer {
  questionID Int
  values     String[]
}

model EventSignup {
  …unchanged…
  /// Purged in place by scripts/remediation/purge-event-answers.mjs: this list
  /// is emptied and Event.answersPurgedAt is stamped, while the ROW survives so
  /// the signup and attendance COUNTS survive. See D-52.
  answers   EventAnswer[]
}
```

**Why embedded rather than a fourth collection.** Retention is the deciding argument. A purge
is `$set answers: []` on the signup rows — the row, and therefore the count, survives by
construction. A separate `EventAnswer` collection would need a delete, and the count would then
live somewhere the purge does not touch, which is two facts to keep in step instead of one.
The write-atomicity argument (mistake ④) falls out for free from the same choice.

**MUST-VERIFY, and it is a real risk (T-24).** Every `EventSignup` row written before this
change has **no `answers` key at all**. Prisma+Mongo returns `[]` for an absent *scalar* list;
for an absent **composite** list this repo has no precedent — `schema.prisma` has ten `type`
blocks (`:11-76`) and every one is legacy introspection on Food/Gym/Supper, none of them
hand-authored, and **none has a zod schema mirroring it**. If Prisma throws instead of
returning `[]`, invariant I-2's exact failure mode fires: *"a row written by a script or a
partial hand-fix that omitted a required scalar would break Prisma deserialization for every
subsequent reader"* (`schema.prisma:700`).

**The verification is §13.2 step 2 and it is BLOCKING**: create an `EventSignup` row with no
`answers` key, then read it through `db.eventSignup.findMany`. Production has 0 signups
(§0.1, unverified), so the population at risk is zero *today* — which means this must be
checked **before** the first signup lands, not after. **If it throws, the fallback is a
separate `EventAnswer` collection keyed `[eventID, userID, questionID]`, written in the same
`withEventLock` block**, and §13.2 says so rather than leaving the coder to invent one.

Every writer sets `answers` **explicitly** (`answers: []` when there are none) — T-12, and the
same rule `create` already follows for the four Phase-2 `Event` fields (`R:610-640`).

### D-50 — `exportAttendees` gains one column per question, and keeps joining PII live

`exportAttendees` (`R:1353`) returns `questions` alongside `attendees`, and each
attendee gains `answers`. `EventAttendees.tsx:31-40` builds the header as:

```
["Name", "Matric", "Block", "Telegram", "Signed up at", ...questions.map(q => q.label)]
```

**PII is still joined live.** `resolveAttendees` (`R:194-252`) is untouched: name,
matric, block and telegram come from `User`/`UserMatric` at export time, never from a snapshot,
so an export always reflects current profile data. That is stated in the `EventSignup` doc
comment (`schema.prisma:821-825`) and stays true. **The answers are the one thing that IS
stored on the signup**, because they are an answer to a question at a moment, not a current
fact about a person.

**Two traps, both in §14.**

- **T-28 — CSV formula injection.** See **D-50a**, which corrects both the file path and the
  blast-radius claim the original draft made here.
- **T-29 — a purged event must export `—`, not blank.** After `answersPurgedAt` is set, an
  empty answer cell is indistinguishable from "nobody answered". The export renders the literal
  string in §11.2 for every answer cell of a purged event, and the head's table says so once at
  the top.

### D-50a — CSV injection: the right file, and the fix does NOT reach the roster export

The original T-28 bullet in D-50 got two things wrong. Both are corrected here, because a coder
following the old text would edit a file that does not exist and would then believe a second
export had been fixed when it had not been touched.

**Correction 1 — the path.** There is **no `src/lib/format.ts`**. `csvField` lives at
**`src/app/events/_lib/format.ts:116-121`**:

```ts
/** Escape one field per RFC 4180: quote when it contains "," | '"' | newline. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```

Note it is **module-private**. The exported wrapper is `serializeCsv`
(`src/app/events/_lib/format.ts:124-128`), which maps every cell through it.

**Correction 2 — "the CCA roster export gets the fix too" is FALSE. Delete that belief.**

`serializeCsv` has exactly **one** caller in the whole repo: `EventAttendees.tsx:43`, building
the attendee download. The CCA roster export is a **different serialiser on a different format**
— `RosterPanel.tsx:139` calls `downloadXlsx` (`src/lib/xlsx.ts:213`), which goes through
`buildXlsx` (`:127`).

**And the roster does not need the fix.** `sheetXml` (`src/lib/xlsx.ts:64-77`) emits every cell as

```
<c r="A1" t="inlineStr"><is><t xml:space="preserve">…</t></is></c>
```

`t="inlineStr"` is an **inline string**, not a formula cell (`<f>`). Excel does not evaluate a
leading `=` in one. **The XLSX path is structurally immune to formula injection**, so this is a
genuine "no change needed", not an oversight — recorded so a reviewer does not file it as a
missed site, and so nobody "fixes" `xlsx.ts` by prefixing apostrophes into cells that would then
display them.

> **RULING.** `csvField` gains a leading-`'` prefix for `=`, `+`, `-` and `@`. **Blast radius:
> one function, one exported wrapper, one caller — the event attendee CSV.** Nothing else in the
> repo changes, and no other export is affected in either direction.

**Why it matters now and did not before.** Every cell this CSV has ever carried came from a
controlled vocabulary or a profile field. Part B puts two **attacker-authored** strings into it:
a **question label**, which becomes a **column header**, and a **free-text answer**. A head types
`=HYPERLINK("https://evil","Click")` as a question label and every committee member who opens the
download in Excel gets a live formula.

**The fix, and the one thing to get right about it:**

```ts
function csvField(value: string): string {
  // A leading =, +, - or @ makes Excel and Sheets treat the cell as a FORMULA.
  // Prefix an apostrophe, which those apps consume as "this is text".
  // MUST run BEFORE the quoting test below: prefixing after quoting would put
  // the apostrophe outside the quotes and corrupt the field.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}
```

**Ordering is the trap.** Neutralise first, then quote. Reversing them yields `'"=x,y"` — the
apostrophe outside the quoted field — which is both wrong CSV and still a formula.

**A negative number is not a formula.** `-5` gets an apostrophe under this rule and imports as
text. Accepted: the alternative is a number-shaped exclusion that `-5+cmd` slips through. The
only numeric cells here are `number` answers, which nothing downstream sums.

### D-51 — PDPA: the builder carries a visible line about what not to ask

Verbatim copy in §11.2, rendered **above** the "Add a question" control, not in a tooltip and
not behind a disclosure.

**Why it is worth the pixels.** A CCA head is not a data controller and has had no training.
The audience for an answer is *whoever holds a headship in that CCA this term* — a set that
turns over annually and that the app itself rotates through `cca.handoverHeads`. Dietary,
allergy and medical answers are health-adjacent data about a named resident, readable by next
year's committee, exportable to a spreadsheet, and retained until somebody runs a script. The
right control is not a blocklist — "any allergies?" is a legitimate question for a supper
event and a regex would either miss it or ban it — it is **telling the head who will read it,
at the moment they are typing it.**

The line is paired with the resident-facing retention line (D-52), so both sides of the form
say the same thing.

### D-52 — Retention: a READ CUTOFF the app enforces, plus a script that erases

This is the decision the brief's warning is about — *"a retention promise nothing executes is
worse than not making it."* **There is no cron in this repo**: no `vercel.json`, no cron key in
`package.json` or `next.config.js`, and every scheduled thing in `scripts/remediation/` is
something a human runs. So the promise is made in **two layers**, and the copy is worded to
the layer the *code* guarantees.

**Layer 1 — the read cutoff, which is unconditional and needs nobody.**

```ts
// lib/schemas/eventQuestion.ts — client-safe, so the resident form and the
// head's table agree about the same boundary.
export const EVENT_ANSWER_RETENTION_DAYS = 60;
export function answersAreRetained(
  endTime: number | null, startTime: number | null, nowSec: number,
): boolean {
  const ref = endTime ?? startTime;
  if (ref == null) return true;                    // no date on file: nothing to count from
  return nowSec < ref + EVENT_ANSWER_RETENTION_DAYS * 86_400;
}
```

`getAttendees`, `exportAttendees` and `getSignupAnswers` **return no answers at all** when this
is false, whether or not the rows still hold them, and whether or not `answersPurgedAt` is set.
The head sees the retention notice instead. **This makes the promise true in the application
the moment the clock passes**, independent of any operator.

**Layer 2 — the erasure, which is a script somebody runs.**

`scripts/remediation/purge-event-answers.mjs`, dry run by default:

```
for every Event with (endTime ?? startTime) older than 60 days AND answersPurgedAt == null:
   updateMany EventSignup where { eventID }  ->  $set { answers: [] }
   update    Event      where { eventID }    ->  answersPurgedAt = now
report: events swept, signup rows touched, answers removed
```

Signup rows are **never deleted**, so signup and attendance counts survive untouched — which
is the whole point, and is why the dashboards in Part D keep working on a purged event.

**Who runs it: nobody, automatically. Say so.** The script header says it, `README.md` says it
(D-81), and this plan says it here. What makes that acceptable is layer 1: the answers stop
being *reachable* on time regardless. What layer 2 buys is that they stop *existing*, and that
is a human's job in a repo with no scheduler. **Do not word the resident-facing copy as though
layer 2 were automatic** — §11.2's string is written against layer 1 for exactly this reason,
and if a future phase adds a scheduler the copy can be strengthened then.

**`answersPurgedAt` already exists** (`schema.prisma:810`, landed inert by D-17) and is already
written explicitly as `null` by `create` and `duplicate` (`R:639`), which is what makes
`where: { answersPurgedAt: null }` find Phase-1 rows at all. That was T-12's whole argument and
this is the query it was arguing about.

### D-53 — Audit: `saveQuestions` writes nothing; the retention script writes nothing either

C-3's rule is unchanged: **state-machine transitions are audited, field saves are not.**
Questions are fields of an event. `saveQuestions` fires on every builder save and would bury
the six rows that describe what happened to an event.

**`exportAttendees` already audits** (`R:1381-1388`) and its row now covers a strictly
larger PII payload — the same audit row, more data behind it. Its `reason` gains the question
count so the log distinguishes "exported 40 names" from "exported 40 names and their answers":
`` `${n} attendee(s), ${q} answer column(s)` ``.

**The purge script writes no `RoleAuditLog` row.** It is not an actor with a session, and
`writeAudit` requires an `actorUserID` (`admin.ts:434-441`). Its record is `Event.answersPurgedAt`
plus its own stdout, which the operator redirects to a file exactly as with every other script
here. Inventing a synthetic actor id to satisfy a log's schema would put a fictional person in
the one table whose purpose is "who did what".

**One new action name is added** — see D-70, `event.checkin.undo`, in Part C. Part B adds none.

---

## PART C — Phase 3: QR attendance

### D-54 — The ORGANISER scans the RESIDENT. Not the other way round.

The resident's phone shows a rotating code; a committee member's phone reads it.

**Why this direction and not a poster at the door.** A static code on a wall is a code that
gets photographed and sent to a group chat, and the app has no way to tell a person from a
screenshot of a person. Reversing it puts the *scanner* on a device the app has already
authenticated and authorised for this specific event, and puts the *rotating* half on the
resident's own screen where a photograph is stale in 30 seconds. It also means the confirmation
— name, on-the-list-or-not, running count — lands on the committee's screen, which is where
the decision is actually made.

### D-55 — The token: HMAC over purpose | userID | window, 30-second windows

```ts
// src/server/api/services/eventQr.ts — SERVER ONLY. Never imported from src/app/**.
const PURPOSE = "event-checkin";
const WINDOW_SECONDS = 30;

function tag(userID: string, window: number): string {
  return createHmac("sha256", qrSecret())
    .update(`${PURPOSE}|${userID}|${window}`)     // PIPE — see mistake ⑤ / T-25
    .digest("base64url")
    .slice(0, 32);                                 // 192 bits
}

export function currentWindow(nowSec: number): number {
  return Math.floor(nowSec / WINDOW_SECONDS);
}
export function mintCheckInToken(userID: string, nowSec: number) {
  const w = currentWindow(nowSec);
  return { token: tag(userID, w), expiresAt: (w + 1) * WINDOW_SECONDS };
}
export function verifyCheckInToken(userID: string, token: string, nowSec: number): boolean {
  const w = currentWindow(nowSec);
  // BOTH the current window AND the previous one, so a scan that straddles a
  // rotation boundary works. Two comparisons, both constant-time, and NEITHER
  // short-circuited — an early `return true` on the first match leaks which
  // window matched, which is a 30-second timing oracle on the boundary.
  const a = tokenMatches(token, tag(userID, w));
  const b = tokenMatches(token, tag(userID, w - 1));
  return a || b;
}
```

**Why the purpose string is FIRST and pipe-separated.** It is domain separation. Today
`event-checkin` is the only thing signed with this key; the day a second feature signs
something, a token minted for one must not verify against the other. Putting the purpose first
means no other payload can be constructed that collides with an `event-checkin` payload by
rearranging its own fields. The separator is `|` because `EXT:` ids contain `:` (mistake ⑤,
T-25) and neither namespace can contain `|` — the same choice `signRow` already made at
`admin.ts:352-365`.

**Why 192 bits and not the full 256.** The QR must stay small enough to decode from a phone
screen across a table. 32 base64url characters plus a ~10-character userID plus a 3-character
prefix is ~45 bytes — a version-3 QR at error-correction level M, which is comfortable. A
192-bit tag with a 30-second life is not the weak link in anything.

**`tokenMatches` is reused verbatim from `admin.ts:367-373`** — `Buffer.from(…, "utf8")`,
**length check first**, then `timingSafeEqual`. `timingSafeEqual` *throws* on a length mismatch
(T-26), and a bare `===` on an HMAC leaks length, which the existing comment already calls "a
bad habit". Extract it to `eventQr.ts` or import it; do not write a second copy.

**No secret ever reaches the browser.** `eventQr.ts` imports `~/env` and `node:crypto` at
module scope. `admin.ts` does the same and the repo already documents the consequence
(`services/roles.ts:602,646`, `AuditLogTable.tsx:8`): such a module **cannot be imported from a
`"use client"` file**. Every constant the client needs — the QR wire prefix, the refresh
interval, the payload parser — lives in `src/lib/schemas/eventAttendance.ts`, which imports
nothing but `zod`. That split is the same reason `_lib/format.ts` exists.

### D-56 — `EVENT_QR_SECRET`, declared optional, failing closed and loudly (ruling C-8)

`src/env.js` — **three edits, and the third is the one that is silently skipped**:

```js
// server:
//   The signing key for event check-in QR codes (services/eventQr.ts).
//   OPTIONAL here and REQUIRED in fact, exactly like BLOB_READ_WRITE_TOKEN
//   above: making it required would stop the whole app building for any
//   contributor who has not pulled it. qrSecret() throws
//   ATTENDANCE_NOT_CONFIGURED when it is missing, so the breakage is localised
//   to the one feature that needs it — and event.attendanceStatus reports
//   WHICH thing is missing rather than a generic failure.
EVENT_QR_SECRET: z.string().min(32).optional(),
// runtimeEnv:  <-- MISS THIS AND IT READS undefined FOREVER
EVENT_QR_SECRET: process.env.EVENT_QR_SECRET,
```

`emptyStringAsUndefined: true` (`env.js:82`) means `EVENT_QR_SECRET=""` is `undefined`, not an
empty key. That is the correct behaviour and it is why the accessor's check is a simple absence
check.

```ts
function qrSecret(): string {
  const s = env.EVENT_QR_SECRET;
  if (!s) {
    // The planSecret() argument, admin.ts:310-321: "Without a secret the token
    // is unforgeable-by-nobody, which is worse than an outage."
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR",
                          message: "ATTENDANCE_NOT_CONFIGURED" });
  }
  return s;
}
```

**Generate it with `openssl rand -base64 48`.** Rotating it invalidates every outstanding
token, which is a 30-second inconvenience and never a data loss — `EventAttendance` rows do not
reference the key.

**Deployment order is part of the rollout and is BLOCKING (§12.4):** set the Vercel env var,
redeploy, confirm `event.attendanceStatus` reports ready, **then** flip
`events.attendance.enabled`. In that order the flag can never be on while the secret is absent.

### D-57 — The QR wire format, and the userID it carries in cleartext

`src/lib/schemas/eventAttendance.ts` (client-safe):

```ts
export const QR_PREFIX = "RH1";
export const QR_REFRESH_MS = 20_000;       // refetch before the 30s window ends

/** RH1|{userID}|{token}. Pipe, because EXT: ids contain a colon (T-25). */
export function buildCheckInPayload(userID: string, token: string): string {
  return `${QR_PREFIX}|${userID}|${token}`;
}
export function parseCheckInPayload(raw: string):
  { userID: string; token: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 3 || parts[0] !== QR_PREFIX) return null;
  if (!parts[1] || !parts[2]) return null;
  return { userID: parts[1], token: parts[2] };
}
```

**The userID is in the payload in cleartext, and that is a real, accepted cost (T-27).** The
server cannot reverse an HMAC, so it must be told *whose* token to recompute; the alternative
is a lookup table of opaque handles, which is a new collection and a new key-rotation problem
for a marginal gain. What is actually leaked, and to whom:

- A bystander who photographs a resident's screen gets a canonical userID — which is an
  `@u.nus.edu` address one derivation later, the class this repo cares about — plus a token
  that is dead within 30 seconds.
- That same userID is **already** visible to every CCA head who exports their attendee list
  (`exportAttendees` returns `userID`, `event.ts:1191`) and to every head's on-screen table
  (`EventAttendees.tsx:106`).

So the marginal disclosure is a bystander at a door, not a new capability. It is recorded as a
trap rather than solved. **`parseCheckInPayload` must not be used to look a person up for any
purpose other than a check-in**, and `event.checkIn` must never return anything about a userID
whose token did not verify — otherwise the door page becomes an oracle for "does this id
exist".

### D-58 — Two new dependencies, named, sized and justified

Measured with `npm view <pkg> dist.unpackedSize` on 2026-08-26:

| Role | Choice | Version | Unpacked | Rejected, and why |
|---|---|---|---|---|
| **Draw** a QR | **`qrcode.react`** | 4.2.0 | **115 KB** | `qrcode` (135 KB) is a canvas/Node API needing a wrapper; `qrcode.react` renders an SVG React component directly, which is what a client component wants and what scales cleanly on a phone. |
| **Decode** from camera | **`jsqr`** | 1.4.0 | **280 KB** | `@zxing/browser` + `@zxing/library` = **17.6 MB** unpacked, for one QR format. `html5-qrcode` = 2.6 MB and owns the whole camera UI. `qr-scanner` = 524 KB and ships a worker. `jsqr` is a single pure-JS function over an `ImageData` — no worker, no wasm, no DOM opinions — so the door page owns its own `<video>`, its own permission gesture and its own error branches, which D-62 needs. |

**`BarcodeDetector` is preferred at runtime when it exists**, and `jsqr` is the fallback:

```ts
const native = "BarcodeDetector" in window
  ? new BarcodeDetector({ formats: ["qr_code"] }) : null;
```

Chromium on Android has it and it is hardware-accelerated; Safari does not, which is the whole
reason the fallback is not optional. **`jsqr` is imported lazily** (`await import("jsqr")`)
from inside the scanner component so 280 KB never lands in the shared bundle for the ~100% of
page loads that are not a door scan.

**Record the exact `npm view` output in the PR description.** These figures were measured on
one day from one registry and a plan is not a lockfile.

### D-59 — `EventAttendance`: one row per person per event, snapshotting `wasSignedUp`

```prisma
/// One person checked in at one event's door. A HARD-DELETE on undo (the row is
/// removed and the undo is audited), which keeps the unique index clean and
/// makes the attendance count a simple row count — the same reasoning as
/// EventSignup's cancel.
///
/// I-2: every scalar nullable or defaulted. And I-2 is NOT a licence to omit
/// them: every writer sets all six EXPLICITLY, because `{ wasSignedUp: false }`
/// matches a STORED false and NOT an absent key (T-12).
model EventAttendance {
  id          String    @id @default(auto()) @map("_id") @db.ObjectId
  eventID     Int
  /// CANONICAL userID (I-1) of the person who attended.
  userID      String
  checkedInAt DateTime? @default(now())
  /// CANONICAL userID (I-1) of the SCANNER. An identity field: never expose it
  /// to the hall-office tier. No oversight procedure reads this collection
  /// today, which is why it needs no redaction list — see D-69.
  checkedInBy String?
  /// "qr" | "manual". Enforced in code (lib/schemas/eventAttendance.ts), never
  /// a DB enum, for the same reason Event.status is a String.
  method      String?   @default("qr")
  /// Was this person on the signup list AT THE MOMENT THEY WERE SCANNED?
  /// SNAPSHOTTED, never re-derived: cancelSignup is a hard delete with no time
  /// gate (event.ts:1802-1811), so a resident who checks in and then cancels
  /// would otherwise retroactively become a walk-in. See T-36.
  wasSignedUp Boolean?  @default(false)

  @@unique([eventID, userID], map: "event_attendee")
}
```

**No `@@index([eventID])`.** The unique index leads with `eventID`, so the per-event roster
read and the dashboards' `{ eventID: { in: [...] } }` are both served by its prefix (C-6).

**The unique index is what makes a re-scan idempotent.** A second scan of the same person
throws `P2002`, which `checkIn` catches and turns into `alreadyCheckedIn: true` carrying the
**existing** row's `checkedInAt` — the same pattern as `signup`'s backstop
(`event.ts:1786-1797`). Without the index (mistake ②) a double scan writes two rows and the
count is wrong, silently.

### D-60 — `event.checkIn` — the whole procedure

```
checkIn: identifiedProcedure.input({ eventID, payload: z.string().max(200) }):
 1. await assertEventsEnabled(db)
 2. await assertAttendanceEnabled(db)                       // D-66, and it also
                                                            // proves qrSecret() exists
 3. userID = ctx.session.user.userID
    roles  = await getUserRoles(db, userID)                 // I-5 live read
 4. event  = await db.event.findUnique({ where: { eventID } })
    if (!event) NOT_FOUND "NO_SUCH_EVENT"
    if (normalizeStatus(event.status) !== "published")
      PRECONDITION_FAILED "NOT_PUBLISHED"
 5. await assertMayScan(db, userID, roles, event)           // D-61 — the ONLY
                                                            // scanner branch
 6. window check (D-65):
      opens  = event.attendanceOpensAt  ?? (event.startTime - 3600)
      closes = event.attendanceClosesAt ?? ((event.endTime ?? event.startTime) + 3600)
      if (nowSec < opens)  PRECONDITION_FAILED "DOOR_NOT_OPEN"
      if (nowSec > closes) PRECONDITION_FAILED "DOOR_CLOSED"
 7. parsed = parseCheckInPayload(input.payload)
    if (!parsed) BAD_REQUEST "BAD_QR"
    if (!verifyCheckInToken(parsed.userID, parsed.token, nowSec))
      BAD_REQUEST "BAD_QR"           // SAME code as an unparseable payload:
                                     // a distinct "expired" code would tell a
                                     // prober that the id exists (D-57)
 8. wasSignedUp = (await db.eventSignup.findUnique({
      where: { eventID_userID: { eventID, userID: parsed.userID } },
      select: { eventID: true } })) !== null                // SNAPSHOT, T-36
 9. try { await db.eventAttendance.create({ data: {
        eventID, userID: parsed.userID, checkedInAt: new Date(),
        checkedInBy: userID, method: "qr", wasSignedUp } }) }
    catch (P2002) { existing = findUnique(...); return {
        alreadyCheckedIn: true, displayName, wasSignedUp: existing.wasSignedUp,
        checkedInAt: existing.checkedInAt, count } }
10. resolve the person's display name via resolveAttendees(db, [parsed.userID])
11. count = await db.eventAttendance.count({ where: { eventID } })
12. return { alreadyCheckedIn: false, displayName, wasSignedUp, count }
```

**Step 8 before step 9, and stored, not derived.** T-36.

**No `withEventLock`.** Two scans of *different* people do not contend, and two scans of the
*same* person are resolved by the unique index. Taking the signup lock here would put the door
behind the same mutex as signup, on the one path where latency is a person standing in a queue.

**No audit row for a check-in** (D-70). The `EventAttendance` row **is** the record: it carries
who, when and by whom. A parallel audit row would be a duplicate of a row that already exists,
in a table that pages 25 at a time.

### D-61 — Who may scan: the head, or a nominee re-validated against LIVE membership

One helper, and — like `loadOwnedEvent` — **the branch lives in exactly one place**:

```ts
// routers/event.ts
async function assertMayScan(db, userID, roles, event): Promise<void> {
  // 1. The owner always may. Same two ownership shapes as loadOwnedEvent.
  if (event.ccaID == null) {
    if (computeCapabilities(roles).manageHallEvents) return;
  } else {
    try { await assertHeadsCca(db, { userID, roles }, event.ccaID); return; } catch {}
  }
  // 2. A NOMINEE — and the stored list is necessary, never sufficient.
  if (!event.scannerUserIDs.includes(userID)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
  }
  if (event.ccaID == null) {
    // A hall event has no membership set to re-validate against. See below.
    if (!computeCapabilities(roles).manageHallEvents) {
      throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
    }
    return;
  }
  if (!(await isLiveCcaMember(db, userID, event.ccaID))) {
    throw new TRPCError({ code: "FORBIDDEN", message: "NOT_A_SCANNER" });
  }
}
```

**Why the stored list is never sufficient.** `scannerUserIDs` is written once, when the head
sets up the event. A nominee who leaves the CCA — or is removed from it — keeps their row in
that array forever, because nothing sweeps it. Re-validating at scan time is the same argument
`assertHeadsCca` makes for reading `CcaHead` live rather than trusting a role string
(`ccaScope.ts:40-47`), and the same argument I-5 makes for `getUserRoles`.

**`isLiveCcaMember` is a new helper in `services/ccaMembers.ts`, beside `membershipKeysFor`,
and it must use ALL of a person's membership keys (T-32).** `UserCCA.userID` is mixed-format —
a person can hold a legacy A-format row *and* a canonical row for the same CCA, which is
exactly why `membershipKeysFor` exists and why its comment says *"REMOVAL MUST USE ALL OF
THEM"* (`ccaMembers.ts:37-44`). A lookup on the canonical key alone reports "not a member" for
anyone whose only row is the legacy one, and the failure mode is a committee member standing at
a door being told they are not in their own CCA.

**A hall event's nominee must hold `manageHallEvents`, and that is a real limitation.** There
is no membership set to re-validate a hall nominee against, and "any resident the JCRC typed
in" is an unbounded grant of a door surface with no live revocation signal. So in this phase
the JCRC cannot deputise a non-JCRC volunteer for a hall event. Recorded in §15 as something a
later phase can fix properly — most likely with a per-event, expiring nomination that carries
its own revocation, rather than by widening this check.

**SCRC never reaches any of this.** `checkIn` is on `identifiedProcedure` and every branch
above requires either a headship, `manageHallEvents`, or CCA membership. Constraint 8 holds by
construction, not by a check.

### D-62 — The door page: camera, live confirmation, running count, undo, manual list

Route `/cca/[ccaID]/events/[eventID]/door` and `/admin/events/hall/[eventID]/door`, both
rendering one client component `EventDoorScanner`. **Props are `eventID: number` and
`backHref: string`. No function props** (mistake ③, §13.1).

What is on the page, top to bottom:

1. **A header** with the event title, the door window, and a live **checked-in count**.
2. **The camera panel.** It starts *stopped*, behind an explicit **"Start camera"** button —
   iOS Safari requires `getUserMedia` to originate in a user gesture, and calling it on mount
   fails on the platform half the hall is holding.
3. **The confirmation card**, replacing the last scan's result: the resident's **display name**
   in large type, a **green "On the list"** or **amber "Not on the list — checked in anyway"**
   badge, the time, and an **Undo** control that stays for that scan.
4. **The manual list, ALWAYS VISIBLE — not a fallback behind an error (T-33).** A search box
   over the pre-loaded roster (D-63), each row with a "Check in" button. If the camera never
   works on a committee member's phone, the page is still completely usable and they never see
   an error state they have to reason about.

**Scanning loop:** `requestAnimationFrame` → draw the `<video>` frame to an offscreen canvas →
`BarcodeDetector.detect()` if available, else `jsqr(imageData…)` → on a hit, **stop decoding**,
call `checkIn`, show the card, and resume after the result is rendered. A 1.5-second
same-payload suppression window stops one QR held in front of the lens firing ten times; the
unique index makes that harmless anyway, but ten "already checked in" cards is a bad door.

**Every `checkIn` outcome renders something.** `BAD_QR`, `DOOR_NOT_OPEN`, `DOOR_CLOSED`,
`NOT_A_SCANNER`, `NOT_PUBLISHED`, `ATTENDANCE_DISABLED`, `ATTENDANCE_NOT_CONFIGURED` all have
their own string in §11.3. A scanner at a door cannot debug a generic failure.

### D-63 — The pre-loaded roster, and why it does NOT carry full matric numbers

`event.getDoorRoster({ eventID })` — same `assertMayScan` gate as `checkIn`. Returns one row
per signup:

```ts
{ userID, displayName, block, matricSuffix, signedUp: true, checkedIn: boolean }
```

**`matricSuffix` is the last four characters** (rendered `••••567X`), never the full number.

**Why.** `getAttendees` returns the full matric today and is not audited, on the stated grounds
that "the head is already authorised to see it" (`event.ts:1117`). The door roster goes to a
**wider audience**: every nominated scanner, who is any CCA member the head picked. Handing
each of them the matriculation number of every person who signed up is a real widening of a PII
surface for no operational gain — a committee member ticking someone off is reading a student
card and needs to *disambiguate two people with similar names*, which four characters do.

Search is client-side over `displayName` and `matricSuffix`, which satisfies "searchable by
name and matric" without shipping the list. **The head still gets full matric** through
`getAttendees` and the audited `exportAttendees`; nothing is taken away from anyone who had it.

**Walk-ins are not in the roster** — by definition they did not sign up. The manual path for a
walk-in is D-64.

### D-64 — Walk-ins are checked in regardless, by QR or by name

**By QR:** step 8 of D-60 records `wasSignedUp: false` and the write proceeds. The card says
"Not on the list — checked in anyway". **There is no branch that refuses.**

**Manually:** `event.checkInManual({ eventID, userID })`, same gate, writes
`method: "manual"`. Two entry points — a roster row's "Check in" button (`userID` from the
row), and a **"Someone not on the list"** control that resolves a person by matric or name.

**The walk-in resolver is the one part of the door page that is a lookup primitive**, so it is
narrow on purpose: `event.resolveWalkIn({ eventID, query })` accepts a **full matric** (exact
match on `UserMatric.matric`, uppercased) or a display-name substring of at least 3 characters,
returns **at most 8** rows of `{ userID, displayName, block }`, and returns **nothing at all**
for a query that matches more than 8. It is not paginated, it is not an enumeration surface,
and it returns no matric, no email and no telegram.

**The whole feature is informational (D-77)**, so a mis-scan costs nothing — which is exactly
why the door must never refuse a real person standing in front of it.

### D-65 — The check-in window, and where its defaults live

`attendanceOpensAt` / `attendanceClosesAt` already exist (`schema.prisma:804-806`) as epoch
**seconds**, both null, both written explicitly as null by `create` and `duplicate`.

**Defaults are computed at READ time, in one exported function, never backfilled:**

```ts
// lib/schemas/eventAttendance.ts — client-safe, so the head's editor, the door
// page and the server all agree.
export function doorWindow(e: {
  startTime: number | null; endTime: number | null;
  attendanceOpensAt: number | null; attendanceClosesAt: number | null;
}): { opens: number | null; closes: number | null } {
  if (e.startTime == null) return { opens: null, closes: null };
  return {
    opens:  e.attendanceOpensAt  ?? e.startTime - 3600,
    closes: e.attendanceClosesAt ?? (e.endTime ?? e.startTime) + 3600,
  };
}
```

**Why computed and not backfilled.** A backfill freezes the default onto rows created before
anyone thought about it, and then a head who moves the event's start time finds the door window
still pointing at the old one. Deriving keeps them in step.

**The head edits them** in a small "Door" section of the authoring screen, alongside the scanner
picker (D-68). Both are written by `event.update`, which means they inherit `editScope`: they
are editable in `draft` / `changes_requested` — and **also while `published`**, because the
window and the scanner list are exactly the two things a head needs to fix on the day. That
requires adding them to `update`'s `"public"` scope branch (§6.2), which is the one deliberate
widening of that scope in this plan and is called out as such.

**`attendanceOpensAt`/`attendanceClosesAt` are epoch SECONDS while `answersPurgedAt` is a
`DateTime`, on the same model.** T-31. Mixing them in one comparison is a 1000× error that
compiles.

### D-66 — A second kill switch, `events.attendance.enabled`, and it ships DARK

```ts
// services/events.ts, beside areEventsEnabled — same shape, same 15s TTL,
// same fail-closed, same "a failed read is not cached".
const ATTENDANCE_FLAG_KEY = "events.attendance.enabled";
export async function assertAttendanceEnabled(db: PrismaClient): Promise<void>
```

It is the first line of `myCheckInToken`, `checkIn`, `checkInManual`, `undoCheckIn`,
`getDoorRoster`, `resolveWalkIn` and `getAttendanceStats` — **after** `assertEventsEnabled`, so
turning events off turns attendance off too and the two switches nest rather than race.

`scripts/remediation/set-attendance-flag.mjs`, modelled on `set-events-flag.mjs`, with **one
addition that matters**: `on --commit` **REFUSES** unless it can prove
`EventAttendance.event_attendee` and `EventQuestion.event_question` exist, by reading
`listIndexes`. A flag that cannot be switched on without its indexes is a stronger control than
a checklist item, and it is the direct answer to mistake ②.

**It ships dark.** No flag row means off (`areEventsEnabled`'s absent-row rule). One trial
event, one door, one evening, then decide.

### D-67 — `event.myCheckInToken` — the resident's side

`identifiedProcedure`, input `{ eventID }`. Returns `{ token, expiresAt }` — **and nothing
else**.

It refuses unless the event is `published` **and** the caller has an `EventSignup` **or** the
door window is currently open. The signup case lets a resident have their code ready before
they arrive; the window case is what makes a walk-in's QR work at all.

**The client refetches at `QR_REFRESH_MS` (20 s), which is deliberately shorter than the
30-second window** so the displayed code is never the one that is about to expire. Combined
with `checkIn` accepting `w` and `w-1`, a scan is valid for between 30 and 60 seconds after
it was minted — which is what makes a queue at a door work.

**The QR renders on the event's public page** (`/events/{eventID}`), inside the "You're going"
branch (`EventDetail.tsx:147-163`) and, for a walk-in, inside a **"Show my check-in code"**
disclosure that appears only while the door window is open. It is behind auth, on the
resident's own device, and it is never rendered on any list.

### D-68 — Nominating scanners

A **"Door"** section on the authoring screen, below the questions builder:

- the window (D-65);
- a **scanner picker**. For a CCA event it lists the CCA's own members —
  `cca.memberDirectory` already exists behind `assertHeadsCca` and is the list the brief names.
  For a hall event it uses `admin.resolveJcrcCandidate`, an existing per-target resolver that
  is **already audited**, so a JCRC member typing an identifier leaves the same trace they
  already leave.

Written by `event.update` into `scannerUserIDs`, which requires adding it to
`updateEventInput` with a **`canonicalUserIDSchema`-shaped element validator** —
`src/lib/schemas/cca.ts:` already exports one, and a raw `z.string()` here would let a client
write an arbitrary string into a canonical-id column.

**`scannerUserIDs` is already in `SCRC_HIDDEN_EVENT_FIELDS`** (`R:409`, blanked to `[]`)
and **stays there**. That was T-18, landed while the field was inert; this is the phase that
fills it in, and it is the phase where removing it would matter.

### D-69 — What the SCRC sees of Phase 3: nothing new, and here is the proof

Stated as a line item so its absence from the diff is deliberate and reviewable:

- **This plan adds NO new column to `model Event`.** All four attendance fields
  (`attendanceOpensAt`, `attendanceClosesAt`, `scannerUserIDs`, `answersPurgedAt`) landed in
  Phase 1. `getForOversight`'s `{ ...event }` spread therefore leaks nothing it did not already
  leak, and `SCRC_HIDDEN_EVENT_FIELDS` is complete as it stands.
- **`EventQuestion`, `EventAttendance` and `EventSignup.answers` are unreachable from
  `oversightProcedure`** because no oversight procedure queries them. Verify by grep, not by
  assumption: `listForOversight` (`event.ts:1568-1577`) uses an explicit `select` and
  `getForOversight` (`:1618`) reads only `event`.
- The moment a later phase adds an `Event` column, **T-30 applies again** and the field must be
  classified against every projection the model already has.

### D-70 — Audit: undo is audited, a check-in is not

| Act | Audited? | Why |
|---|---|---|
| `checkIn` / `checkInManual` | **No** | The `EventAttendance` row *is* the record — `userID`, `checkedInAt`, `checkedInBy`, `method`. An audit row would duplicate a row that already exists, hundreds of times per event, in a table that pages 25 at a time. |
| `undoCheckIn` | **YES** — new action **`event.checkin.undo`** (18 chars, under the 32-char cap `admin.listAuditLog`'s `action: z.string().max(32)` imposes, `admin.ts:3035`) | The undo **deletes** that row. Without an audit row the fact is simply gone. A check-in is a claim about where a person physically was; erasing one must not be erasable. |
| `saveQuestions`, `update` (window, scanners) | **No** | C-3: field saves are not transitions. |

`undoCheckIn` is a hard delete plus `writeAudit({ … targetUserID: <the attendee>, targetCcaID:
event.ccaID ?? undefined, targetEventID, action: "event.checkin.undo", reason: event.title ??
undefined })`. **`targetUserID` is set** — it is the one audit row in this feature that is
*about* a specific resident, and `admin.listAuditLog` can filter on it.

`AUDIT_ACTIONS` in `services/roles.ts:261-268` gains the one string. **No name is retired**, so
§0.1's zero-row measurement is not load-bearing here the way D-22's was.

---

## PART D — Phase 4: dashboards

### D-71 — `EventAnalytics.tsx` is EXTENDED, not replaced

It already charts cumulative signups (`AreaChart`, `:77-89`) and a by-block breakdown
(`BarChart`, `:100-107`) on `recharts`, from `getSignupStats`. Both stay exactly as they are.

**Two things are added below them**, in their own section, and the section renders **only**
when attendance is enabled *and* configured:

1. **Live checked-in count** while the door window is open: a large number, `checkedIn / signedUp`,
   refetched every 15 s (`refetchInterval`), with a "turnout so far" label.
2. **After the event closes**, the split — signed up and turned up / signed up and did not /
   walked in — plus a **no-show list** (name, block, telegram) built from
   `signedUp − attended`.

**Why extend.** The two existing charts answer "who registered"; the new ones answer "who
came". They are the same question about the same event and belong on the same screen, and
replacing a working chart to add a second one is how a working chart stops working.

### D-72 — One new query, `event.getAttendanceStats`, separate from `getSignupStats`

```ts
getAttendanceStats: identifiedProcedure.input(eventIdInput).query:
  assertEventsEnabled → assertAttendanceEnabled → loadOwnedEvent
  returns {
    signedUp: number,
    checkedIn: number,
    walkIns: number,            // attendance rows with wasSignedUp === false
    turnedUp: number,           // attendance rows with wasSignedUp === true
    noShows: ResolvedAttendee[],// signed up, no attendance row
    doorOpens: number | null, doorCloses: number | null,
    byMethod: { qr: number; manual: number },
  }
```

**A separate query, not a widened `getSignupStats`.** `getSignupStats` must keep working with
the attendance flag off — the head's signup charts are Phase 1 behaviour and must not start
failing because a Phase 3 switch is off. Two queries fail independently; one merged query fails
together.

**`noShows` uses `resolveAttendees`** (`R:194-252`), so its PII is joined live like every
other attendee read, and it is **not audited** — the same call the head already makes through
`getAttendees` (`event.ts:1117`), same authorisation, same data.

**`walkIns` and `turnedUp` are counted from the STORED `wasSignedUp`**, never re-derived by
re-checking the signup table (T-36). A resident who checks in and then cancels their signup
stays a `turnedUp`, because that is what happened.

### D-73 — `event.attendanceStatus` — a tiny query so the UI never renders a broken section

```ts
attendanceStatus: identifiedProcedure.query():
  returns { enabled: boolean, reason: null | "flag" | "secret" }
```

Reads the flag, and separately checks `env.EVENT_QR_SECRET` is present.

**Why a query and not "let the stats query fail".** With the flag off, the head's page should
show *nothing* about attendance — not an error, not an empty chart. With the flag on but the
secret missing (D-56), the head should be told **which** thing is wrong, because "attendance
doesn't work" sends them to the wrong person. `reason: "secret"` renders the string in §11.4
naming the env var, so the fix reaches whoever can apply it.

It returns no secret and no flag value — only a boolean and an enum.

### D-74 — The JCRC's hall-wide view: a new tab at `/admin/events/insights`

A new route under the existing `/admin/events` layout, so it inherits that layout's live role
read and its `reviewEvents || manageHallEvents` gate (`layout.tsx:39`) with no new gate to get
wrong. `AdminShell`'s `ADMIN_TABS` is **not** touched — `/admin/events` is already a tab
(`AdminShell.tsx:59-64`) and this is a sub-page of it, reached by a link on `/admin/events`.

One procedure:

```ts
getHallStats: roleManagerProcedure.input({ fromSec, toSec }).query:
  assertEventsEnabled
  roles = live getUserRoles ; require computeCapabilities(roles).reviewEvents   // I-5
  returns {
    events: [{ eventID, ccaID, ccaName, title, startTime, status,
               signups, checkedIn, walkIns }],
    byCca:  [{ ccaID, ccaName, events, signups, checkedIn }],
    byWeek: [{ weekStart: "YYYY-MM-DD", events }],
  }
```

`ccaName` comes from `ownerName(ccaID, names)` (`event.ts:317-322`) so a hall event reads
**"Hall"** and a deleted CCA still reads `CCA #{id}` — the client calls `ownerLabel` on the
returned `ccaID`/`ccaName` pair, exactly as the four existing display sites do. **Never guard
with `{ccaName && …}`** (T-4).

**The live `reviewEvents` re-check is not optional** even though `roleManagerProcedure` already
gated the call. This is the I-5 pattern `decide` (`event.ts:1268-1275`) and `reviewerCancel`
(`event.ts:874-880`) both use: the builder proves the caller was a manager when the session was
minted, the re-read proves they still are. A hall-wide roll-up of every CCA's turnout is a
disclosure surface and it gets the same treatment.

### D-75 — There is no term model, so the range is a DATE RANGE with a default

The brief asks for "every event this term". **This repo has no notion of a term** — grep
`schema.prisma` and `src/` for term, semester or academic year and there is nothing.

`getHallStats` therefore takes `{ fromSec, toSec }` and the page defaults to **the last 180
days**, with a visible range picker.

**Why not invent a term.** A term boundary is a second calendar that has to be maintained,
that will be wrong the year the academic calendar shifts, and that nothing else in the app
needs. A date range is honest about what it is, is always correct, and can be pointed at a term
by whoever knows when it started. Recorded in §15 in case a term model ever arrives for another
reason.

### D-76 — What the hall-wide page shows

| Panel | Data | Chart |
|---|---|---|
| **Turnout** | signed up / turned up / walked in, per event | grouped `BarChart`, one group per event |
| **Who is actually running things** | events per CCA in the range | horizontal `BarChart` over `byCca`, sorted desc, "Hall" included as its own row |
| **Calendar density** | events per week | `AreaChart` over `byWeek` |
| **The table** | every event: owner, title, date, status, signups, checked in, turnout % | plain table, links to `/admin/events/{eventID}` |

`recharts` is already a dependency and is already used directly (`EventAnalytics.tsx:3-13`);
`src/components/ui/chart.tsx` exists but is not the house pattern for these two files.

**Turnout % is rendered as `—`, never `0%`, when nothing was scanned.** An event that ran
before attendance was switched on, or one where the committee never opened the door page, has
**no data**, which is a different fact from **nobody came** — and 0% next to a well-attended
event's name is a defamatory number about a CCA.

### D-77 — Attendance is INFORMATIONAL ONLY. Nothing anywhere consequences it.

No penalty, no ban, no priority, no ranking, no "reliability score", no effect on any future
signup, and **no export that pairs a person's name with a no-show flag**. The no-show list
exists on the head's own event page so a committee can chase their own members; it is not on
the hall-wide page and it is not in the CSV.

**Stated as copy, on both dashboards** (§11.4), because a number on a screen acquires a
consequence the moment somebody assumes it has one, and the person best placed to correct that
assumption is the screen.

**This is a binding constraint on future phases, not just this one.** Anything that reads
`EventAttendance` to decide something about a person is out of scope by construction and needs
its own ruling.

---

## PART CROSS-CUTTING — rollout, hygiene, and the things that are not features

### D-78 — Four PRs, in this order, and Part A is not bundled

| PR | Contents | New collection | New index | New flag | New dep |
|---|---|---|---|---|---|
| **1 — Part A** | one authoring screen; `submitForReview` atomicity (D-37); the npm-script and README retractions (D-80, D-81) | — | — | — | — |
| **2 — Part B** | questions, answers, retention, export columns | `EventQuestion` | `event_question` | — | — |
| **3 — Part C** | QR attendance | `EventAttendance` | `event_attendee` | `events.attendance.enabled` | `qrcode.react`, `jsqr` |
| **4 — Part D** | dashboards | — | — | — | — |

**Part A must not be bundled with Part B.** The question builder mounts inside the screen Part A
is fixing; building it into a form that is about to move means building it twice. §0.3 and D-38.

**PR 3 ships dark.** The flag stays absent until a trial event.

### D-79 — I-2, I-5 and T-12 restated for every new field in this plan

- **I-2 — every new scalar is nullable or defaulted.** `EventQuestion`: `helpText String?`,
  `required Boolean? @default(false)`, `options String[] @default([])`, `maxLength Int?`,
  `createdAt DateTime? @default(now())`. `eventID`, `questionID`, `order`, `type` and `label`
  are **required by design** — a question with no type or no label is not a question, and this
  is a brand-new collection with no legacy rows to break. Say so in the schema comment rather
  than leaving the exception unexplained. `EventAttendance`: every scalar but `eventID` and
  `userID` is nullable or defaulted.
- **I-5 — roles are read LIVE inside every new procedure** via `getUserRoles`, never from
  `session.user.roles`. That is: `saveQuestions`, `getQuestionsForOwner`, `getSignupAnswers`,
  `myCheckInToken`, `checkIn`, `checkInManual`, `undoCheckIn`, `getDoorRoster`, `resolveWalkIn`,
  `getAttendanceStats`, `attendanceStatus`, `getHallStats`. Twelve procedures, twelve live reads.
- **T-12 — every nullable/defaulted key is written EXPLICITLY**, in every writer. `answers: []`
  on `eventSignup.create`. `options: []` and `maxLength: null` on every `EventQuestion` upsert.
  All six fields on every `EventAttendance` create. `{ field: null }` matches a stored null and
  **not** an absent key, and the queries that will one day depend on it are being written now.

### D-80 — Delete the four dangerous npm scripts (ruling C-11)

```diff
-    "db:generate": "prisma migrate dev",
-    "db:migrate": "prisma migrate deploy",
-    "db:push": "prisma db push",
-    "db:migrate-and-seed": "prisma migrate dev && prisma db seed",
```

`db:studio` and `postinstall: prisma generate` stay. **This lands in PR 1**, because it is four
lines and because every PR after it tells the coder to run `prisma generate`.

### D-81 — Retract the `prisma db push` instruction everywhere it still stands

Three sites, all found while grounding this plan (C-12, C-13):

| File | Now | Becomes |
|---|---|---|
| `scripts/remediation/README.md:19-27` | "Step 0 — Create the new collections + indexes (REQUIRED) … `npx prisma db push`" | Heading becomes **"Step 0 — Create new collections + indexes (NEVER with `prisma db push`)"**, body names `create-auth-allowlist.mjs` and `create-event-phase2-indexes.mjs` and states why. The instruction is **replaced**, not annotated. |
| `src/server/api/services/events.ts:9-11` | "Requires `prisma db push` so the unique indexes … exist" | "Depends on unique indexes on `EventLock.key`, `Counter.key` and `Event.eventID` — those indexes are what make the lock, the counter and the id allocation safe. They are created with `createIndexes`; see `scripts/remediation/create-event-phase2-indexes.mjs`. **Never `prisma db push` on this cluster** — it drops `User.email_unique_ci`." |
| `prisma/schema.prisma:851-853` (`model EventLock`) | "`prisma db push` must create the unique index on `key`" | same correction, same wording |

The README also gains the two new scripts (`purge-event-answers.mjs`,
`sweep-blank-event-drafts.mjs`) with **who runs them and when**, which is the sentence D-52
depends on being true.

### D-82 — `index-census.mjs`'s `EXPECTED` list gains the two new collections

`index-census.mjs:77-98`. Add `"EventQuestion"` and `"EventAttendance"` to the group commented
*"data the app joins"*, and extend that comment to name them.

**They will print `(absent)` before PR 2 and PR 3 run their index scripts, and that is
correct** — `AuthAllowlist` did exactly the same before its rollout, and the header already
says an absent collection is a note, not an error (`index-census.mjs:63-66`). **Do not add them
to the four-name blocking subset**; that list is for collections that have carried rows since
phase 1 and are read on the authenticated request path.

### D-83 — `verify-events-schema.mjs` gains three checks and stays read-only

It already refuses `--commit` and issues nothing but `listIndexes`, `aggregate` and `find`. It
gains:

| # | Check | Blocking? |
|---|---|---|
| **[8]** | `EventQuestion.event_question` exists and is `unique`, **matched on key pattern `{eventID:1,questionID:1}`, not on name** — `db push` and a hand-run `createIndexes` produce different names for the same index, and a name match reports a false failure (the rule its own `hasUniqueOn()` comment already states, `:152`) | YES after PR 2 |
| **[9]** | `EventAttendance.event_attendee` exists and is `unique` on `{eventID:1,userID:1}` | YES after PR 3 |
| **[10]** | **No orphan answers.** Count `EventSignup` rows with a non-empty `answers` list whose `eventID` has `answersPurgedAt != null`. Must be `0` — a non-zero means the purge stamped an event it did not actually clear, which is the one way the retention promise becomes a lie on disk while looking kept | YES |

Plus **informational**: `EventQuestion` total; distinct `type` values ⊆ `EVENT_QUESTION_TYPES`;
`EventAttendance` total split by `method`; the count of `Event` rows past the 60-day cutoff with
`answersPurgedAt == null` — which is **the number that says how overdue the purge is**, and is
the one line an operator should be able to read at a glance.

**Checks [8] and [9] must not fail the script before their PR has shipped.** They key off the
collection existing at all: absent collection → informational note; present collection with a
missing index → blocking failure. That is the same shape `index-census.mjs` uses for
`AuthAllowlist`.

---

## 2. The status machine — what changes, and what does not

**No status is added, removed or renamed. `EVENT_STATUSES` and `editScope` are untouched.**
The six-word vocabulary from plan 01 §2 stands verbatim, and `STATUS_META` (`format.ts:99-109`)
needs no edit.

Three things change *about* the machine, none of which is a new state:

| # | Change | Where |
|---|---|---|
| **1** | `submitForReview`'s write becomes atomic, closing `canceled → submitted` and `declined → submitted` — two transitions §2.1 never listed because they were never meant to exist | D-37, C-10 |
| **2** | `draft` is entered by a **button press on the list**, not by a form submit on a `/new` route. Same state, same label ("Not submitted"), different door | D-28, D-29 |
| **3** | Two new *sub-lifecycles* hang off `published`, and neither touches `Event.status` | below |

```
   QUESTIONS                                    ATTENDANCE
   editable while editScope != "none"           live while the door window is open
   AND EventSignup count == 0                   (attendanceOpensAt .. attendanceClosesAt)
        │                                            │
        │  first signup                              │  a scan
        ▼                                            ▼
     FROZEN — permanently, for this event      EventAttendance row, unique per person
     (there is no thaw; a head who must        undo = hard delete + one audit row
      change the form cancels and duplicates)
```

**Neither is a status.** Frozen-ness is *derived* from `editScope(status)` and a signup count;
the door window is *derived* from four `Event` columns and the clock. Adding
`Event.questionsFrozenAt` or `Event.doorOpen` would create a second source of truth for a fact
the first source already answers, and the two would drift the first time a signup was cancelled.

**`STATUS_META`, `reviewBranch` (`EventReviewDetail.tsx:63-80`) and the oversight filter all
stay exhaustive over `EventStatus` with no `default`,** which is what makes a future status
addition a compile error in three places. Do not add a `default` to any of them while adding a
sub-lifecycle that is not a status.

### 2.1 The transitions table — unchanged

Plan 01 §2.1's T1…T12 stand exactly as written, with one correction to the *guard* column:

| # | Was | Is |
|---|---|---|
| T2 / T3 | `event.submitForReview` — "`editScope === "all"`; completeness (§2.2)" | …**and the write is `updateMany` scoped `NOT: { status: { in: ["submitted","published","declined","canceled"] } }` with a `count === 0` throw of `NOT_SUBMITTABLE`** (D-37) |

Completeness (§2.2 of plan 01) is **not** extended. A question, a scanner and a door window are
all optional; an event with no questions is a normal event, and `submitForReview` must not start
refusing one.

---

## 3. `prisma/schema.prisma` — the diff

**Four changes. No column is added to `model Event`. `model Bookings` is untouched.**

### 3.1 `EventSignup` gains `answers` (D-49)

```prisma
/// One answer to one EventQuestion. EMBEDDED on EventSignup, so the answer and
/// the signup are ONE document: the capacity check, the signup row and the
/// answers are a single write inside withEventLock and cannot half-apply.
///
/// `values` is ALWAYS a string list, whatever the question's type. The
/// serialisation of each type is defined in EVENT_QUESTION_TYPES'
/// documentation in src/lib/schemas/eventQuestion.ts and NOWHERE ELSE — in
/// particular a `date` answer is a CALENDAR DATE "YYYY-MM-DD", not an epoch,
/// because a question about which day someone can make is not an instant and
/// storing it as one makes the answer shift across timezones. An unanswered
/// optional question is [].
type EventAnswer {
  questionID Int
  values     String[]
}

model EventSignup {
  id        String    @id @default(auto()) @map("_id") @db.ObjectId
  eventID   Int
  userID    String
  createdAt DateTime? @default(now())
  /// PURGED IN PLACE by scripts/remediation/purge-event-answers.mjs: this list
  /// is emptied and Event.answersPurgedAt is stamped, while the ROW SURVIVES so
  /// the signup and attendance COUNTS survive. That is the whole reason the
  /// answers are embedded here rather than in a collection of their own.
  ///
  /// WRITTEN EXPLICITLY, ALWAYS, even when empty (`answers: []`) — the T-12
  /// rule. And note the read side: rows written BEFORE this field existed carry
  /// no `answers` key at all. Verify Prisma returns [] rather than throwing
  /// before the first signup lands (plan 02 §13.2 step 2); if it throws, the
  /// fallback is a separate collection, not a backfill.
  answers   EventAnswer[]

  @@unique([eventID, userID], map: "event_user")
  @@index([eventID], map: "eventID")
  @@index([userID], map: "userID")
}
```

### 3.2 `EventQuestion` — new collection (D-39)

Body as printed in D-39. The doc comment above it must carry three sentences:

- **why it is not a column on `Event`** — `getForOversight` spreads the whole row, so every new
  `Event` column is an SCRC disclosure decision (T-30);
- **why `questionID` is never reused** — an answer references it and would silently rebind;
- **that its unique index does not exist until `create-event-phase2-indexes.mjs` runs**, in the
  same words `model AuthAllowlist` uses (`schema.prisma:467-470`).

### 3.3 `EventAttendance` — new collection (D-59)

Body as printed in D-59. Same three-sentence rule for the index, plus the `wasSignedUp`
snapshot rationale, which is the field most likely to be "simplified" into a live join.

### 3.4 `model Event` — NO CHANGE

Stated as a line item so its absence from the diff is deliberate and reviewable.

All four fields Parts B and C need (`attendanceOpensAt`, `attendanceClosesAt`,
`scannerUserIDs`, `answersPurgedAt`) landed inert in Phase 1 (`schema.prisma:790-810`) and are
already written explicitly by `create` and `duplicate` (`R:610-640`). D-17 said the
attendance work would need no second schema pass on `Event`. **It does not.**

Consequences worth naming: `SCRC_HIDDEN_EVENT_FIELDS` needs no edit (D-69), `toPublicCard`
needs no new field, and the `satisfies Partial<Record<keyof Event, …>>` clause at
`R:410` will not fire.

### 3.5 `model Bookings` — NO CHANGE

D-8. Nothing in this plan creates, deletes or reads a booking. Stated so its absence is
reviewable.

### 3.6 `$jsonSchema` validators — nothing this plan touches has one, and that is checked

`Event`, `EventSignup`, `EventLock` and `Bookings` carry **no** DB-level `$jsonSchema`
validator. The `Event` docblock says so at `schema.prisma:690-691`: *"BRAND-NEW, UNVALIDATED
collection (no `$jsonSchema`) — so, unlike CCA/User, fields may be added here freely"*.

**The validator-guarded set, read from Prisma's own introspection banner** (*"This collection
uses a JSON Schema defined in the database"*), is **eleven** models, at `schema.prisma`
`:120 CCA`, `:136 Crowd`, `:144 Facilities`, `:155 FoodMenu`, `:174 Gym`, `:188 Order`,
`:912 Posts`, `:930 Restaurants`, `:956 SupperGroup`, `:987 User`, `:1022 UserCCA`.

> **C-16 — the brief names a `Profiles` model that does not exist.** The brief's constraint 9
> reads *"`User`, `CCA`, `UserCCA`, `Profiles` DO"*. **There is no `model Profiles` in
> `schema.prisma`** — grep `^model ` and it is absent. The nearest names are `CcaProfile`
> (`:544`) and `ProfileCompletion` (`:900`), and **neither carries a validator**. The label
> appears to be carried forward from an older note. *Ruling: harmless here — this plan adds no
> field to any of the eleven — but the list above is the one to check against, not the brief's.*

**This plan adds a field to exactly one existing model: `EventSignup.answers`.** `EventSignup`
is unvalidated, so the write cannot be rejected with code 121. **No field is added to any
validator-guarded model.**

`EventQuestion` and `EventAttendance` are brand-new collections and therefore have no validator
— but that is an assumption about the cluster, not about the schema file, so **confirm it before
the first insert** with the script that exists for this:

```bash
node scripts/remediation/preflight-scrc-validators.mjs
```

`model AuthAllowlist`'s docblock (`schema.prisma:476-477`) gives exactly this instruction for
exactly this reason. **A validator rejection arrives as `ok: 1` with a `writeErrors[0].code ===
121`, not as a throw** (`create-auth-allowlist.mjs:80-95`) — which is why `ccaMembers.ts` has to
go through `$runCommandRaw` for `UserCCA`, and why an uninspected write reply here would report
success on an insert that did nothing.

### 3.7 Indexes — exactly two, both compound-unique

```
EventQuestion   @@unique([eventID, questionID], map: "event_question")
EventAttendance @@unique([eventID, userID],     map: "event_attendee")
```

**And no others.** Neither collection gets an `@@index([eventID])`: the unique index leads with
`eventID`, so every list query in this plan is covered by its prefix. See §9 for how they are
created, and C-6 for the correction to the brief.

---

## 4. `src/lib/schemas/` — the diff

Four files today; **six** after. Both new files import **`zod` only** — no `@prisma/client`, no
`~/server/**`, no `~/env` — which is the rule at `profile.ts:3-10` and the reason this directory
exists.

### 4.1 `src/lib/schemas/eventQuestion.ts` — NEW

| Export | What |
|---|---|
| `EVENT_QUESTION_TYPES`, `EventQuestionType` | the seven-word vocabulary, `as const` tuple (D-40) |
| `EVENT_MAX_QUESTIONS`, `EVENT_QUESTION_LABEL_MAX`, `EVENT_QUESTION_HELP_MAX`, `EVENT_MAX_OPTIONS`, `EVENT_OPTION_LABEL_MAX`, `EVENT_ANSWER_TEXT_MAX`, `EVENT_ANSWER_DEFAULT_MAXLENGTH` | caps (D-40) |
| `questionDraftSchema`, `saveQuestionsInput`, `SaveQuestionsInput` | the builder payload (D-41a) |
| `answerValueSchema`, `EventAnswerValue` | `{ questionID: int>0, values: string[] max 64, each ≤ EVENT_ANSWER_TEXT_MAX }` |
| `validateAnswers(questions, answers)` | **THE** content validator, shared verbatim by the resident form and `signup` (D-41b) |
| `EVENT_ANSWER_RETENTION_DAYS`, `answersAreRetained(endTime, startTime, nowSec)` | the read cutoff (D-52 layer 1) |
| `QUESTION_TYPE_COPY: Record<EventQuestionType, { label, hint }>` | the builder's type picker. **A `Record` over the type union**, so adding a type without copy is a compile error — the same trick `PROFILE_COMPLETION_COPY` uses (`profile.ts:141-155`) |

The module docblock repeats `profile.ts:3-10`'s reasoning verbatim and adds one paragraph: *the
schema validates the SHAPE of a payload; `validateAnswers` validates its CONTENT against the
STORED questions, and the two are separate because the client's copy of the question list can
be stale.*

### 4.2 `src/lib/schemas/eventAttendance.ts` — NEW

| Export | What |
|---|---|
| `QR_PREFIX`, `QR_REFRESH_MS`, `CHECKIN_WINDOW_SECONDS` | wire constants (D-57) |
| `buildCheckInPayload`, `parseCheckInPayload` | the `RH1\|userID\|token` format, **pipe-separated** (mistake ⑤) |
| `ATTENDANCE_METHODS = ["qr","manual"] as const`, `AttendanceMethod` | the method vocabulary |
| `doorWindow(event)` | the default door window, computed at read time (D-65) |
| `DEFAULT_DOOR_OPEN_LEAD_SEC = 3600`, `DEFAULT_DOOR_CLOSE_LAG_SEC = 3600` | named, so the two `3600`s are not magic |
| `checkInInput`, `checkInManualInput`, `undoCheckInInput`, `doorWindowInput` | tRPC payloads |

**No secret, no `createHmac`, no `~/env` anywhere in this file.** The signing lives in
`src/server/api/services/eventQr.ts`, which the client tree must never import — the same
constraint `routers/admin.ts` already carries and that `roles.ts:602,646` documents.

### 4.3 `src/lib/schemas/event.ts` — small edits only

| Where | Change |
|---|---|
| `eventIdInput` `:392` | unchanged |
| new | `eventSignupInput = z.object({ eventID, answers: z.array(answerValueSchema).max(EVENT_MAX_QUESTIONS).optional() })` (D-43) |
| `updateEventInput` `:279-320` | add `attendanceOpensAt`, `attendanceClosesAt` (`epochSecondsField.nullable().optional()`) and `scannerUserIDs` (`z.array(canonicalUserIDSchema).max(20).optional()` — **`canonicalUserIDSchema` is imported from `cca.ts`**, never a bare `z.string()`, because this column holds identity keys). Extend the existing `superRefine` to require `attendanceClosesAt > attendanceOpensAt` when both are present |
| `createEventInput` **`S:244-258`** | **UNCHANGED — and this is load-bearing.** Every field stays `.optional()`; D-29's bare create sends `{ ccaID }` only, which this schema already accepts. **NEVER add a `.default()` to any field here (D-45a):** zod populates a defaulted field even when the caller omits it, which makes `isBareCreate` (`R:531-533`) false for every bare create — blank-draft reuse then silently never fires again. §13.1(h) greps for it. |
| docblock `:22-26` | the `draft` paragraph is rewritten: it is still a technical staging state, and the sentence "the create form routes straight through" becomes "the New event button creates the row and lands the head on the editor; there is no create form" (D-28) |

**`createEventInput` deliberately does NOT gain `bannerUrl` / `photoUrls` / `publicDescription`.**
That looks like the obvious fix to §0.3 and it is the wrong one: with D-29 there is no form
posting to `create` at all, so those fields would be unreachable input on a mutation nobody
calls with content — and `isOwnEventBlobUrl` cannot validate a banner URL for an event that
does not have an id yet, which is the constraint that started all of this. **The single
authoring screen writes through `event.update`, which already accepts all three.**

---

## 5. `src/server/api/routers/event.ts` — procedure by procedure

Current: 22 procedures, 1,843 lines. After: **34**.

### 5.1 Procedure table

| Procedure | Fate | Part |
|---|---|---|
| `create` **`R:472`** | **edited** — blank-draft reuse (D-30) | A |
| `update` **`R:665`** | **edited** — `attendanceOpensAt` / `attendanceClosesAt` / `scannerUserIDs` written in **both** scopes (D-65) | C |
| `submitForReview` **`R:800`** | **edited** — atomic write (D-37) | A |
| `withdraw` **`R:922`**, `cancelEvent` **`R:988`**, `reviewerCancel` **`R:1065`**, `duplicate` **`R:1141`** | unchanged | — |
| `listForOwner` **`R:1221`**, `getForOwner` **`R:1261`** | unchanged | — |
| `getSignupStats` **`R:1274`** | **unchanged** — deliberately; it must keep working with attendance off (D-72) | — |
| `getAttendees` **`R:1317`** | **edited** — returns `answers` + `answersRetained` (D-52) | B |
| `exportAttendees` **`R:1353`** | **edited** — returns `questions`, per-attendee `answers`, retention state; audit `reason` gains the column count (D-50, D-53) | B |
| `listForReview` **`R:1394`** | unchanged | — |
| `getForReview` **`R:1423`** | **edited** — returns the question list for review (D-47) | B |
| `decide` **`R:1459`** | unchanged | — |
| `listForOversight` **`R:1723`**, `getForOversight` **`R:1816`** | **unchanged** — and D-69 says why | — |
| `listPublished` **`R:1859`** | unchanged | — |
| `getPublic` **`R:1892`** | **edited** — returns `questions` (D-46). **`toPublicCard` is NOT widened** | B |
| `signup` **`R:1939`** | **edited** — `answers`, validated and written inside the lock (D-43) | B |
| `cancelSignup` **`R:2000`**, `listMySignups` **`R:2011`** | unchanged | — |
| — | **new** `saveQuestions` | B |
| — | **new** `getQuestionsForOwner` | B |
| — | **new** `getSignupAnswers` | B |
| — | **new** `myCheckInToken` | C |
| — | **new** `checkIn` | C |
| — | **new** `checkInManual` | C |
| — | **new** `undoCheckIn` | C |
| — | **new** `getDoorRoster` | C |
| — | **new** `resolveWalkIn` | C |
| — | **new** `attendanceStatus` | C |
| — | **new** `getAttendanceStats` | D |
| — | **new** `getHallStats` | D |

22 − 0 deleted + 12 new = **34**. *(Counted twice: the table lists twelve `new` rows. If your
implementation ends with a different number, one of us is wrong and it is worth two minutes to
find out which — plan 01 shipped with this exact arithmetic wrong in its own §5.)*

### 5.2 Authorisation, by procedure — the table a reviewer actually needs

| Procedure | Builder | Gate | Live roles? |
|---|---|---|---|
| `saveQuestions`, `getQuestionsForOwner`, `getSignupAnswers` | `identifiedProcedure` | `loadOwnedEvent` | yes |
| `getAttendanceStats` | `identifiedProcedure` | `loadOwnedEvent` | yes |
| `myCheckInToken` | `identifiedProcedure` | published **and** (own signup **or** door open) | yes |
| `checkIn`, `checkInManual`, `undoCheckIn`, `getDoorRoster`, `resolveWalkIn` | `identifiedProcedure` | **`assertMayScan`** (D-61) | yes |
| `attendanceStatus` | `identifiedProcedure` | none beyond auth — returns a boolean and an enum | no roles needed |
| `getHallStats` | `roleManagerProcedure` | **+ live `reviewEvents` re-check** (D-74) | yes |
| `signup` | `identifiedProcedure` + `requireMatric` | unchanged | — |

**No new procedure is on `oversightProcedure`.** Constraint 8: SCRC stays read-only and gains
neither authorship nor scanning.

### 5.3 `create` — the reuse branch (D-30) — **SHIPPED IN PART A. Part B adds ONE line.**

**Status: done.** The reuse branch is live at **`R:531-571`**, between the ownership branch
(`R:479-499`) and the facility resolution (`R:573-580`). The three rules below are **already
satisfied** in the shipped code and are restated only so a coder does not "simplify" them away:

- **`ccaID` is written explicitly in the `where`** (`R:545`) — the resolved local, not
  `input.ccaID`. T-12: `{ ccaID: null }` matches a stored null and not an absent key.
- **The reuse returns before `nextEventId`** (`R:567-570`). Allocating an id then discarding it
  is a counter gap for no reason.
- **The `NO_SUCH_CCA` check stays inside the non-null arm** (`R:488-497`) and *before* the reuse
  lookup. T-9: hoisting it refuses every hall event.

> **PART B'S ONLY EDIT HERE IS D-39a**, and it is the highest-risk change in this Part.
> `BLANK_EVENT_CONTENT` is `satisfies Partial<Record<keyof Event, null>>` and questions are a
> **separate collection**, so "has no questions" cannot be expressed in the `where` at all. Add
> the `eventQuestion.count` check in JS at **`R:566`**, mirroring the `photoUrls` check already
> there for the same class of reason. **Read D-39a in full before touching this function** — the
> failure mode is a head's abandoned questions silently reappearing on what they believe is a new
> event, and it reaches the JCRC.

### 5.4 `signup` — where the answers go (D-43)

Four changes inside the existing `withEventLock` callback (opened at **`R:1961`**), and
`answers: v.normalized` on the existing `create` at **`R:1982-1985`**:

| # | Change | Where |
|---|---|---|
| 1 | `.input(eventIdInput)` → `.input(eventSignupInput)`. `.use(requireMatric)` **stays** | `R:1940-1941` |
| 2 | **D-43a** — `findUnique` on `event_user` + early `return { signedUp: true }`, at the **top** of the lock | new, `R:1962` |
| 3 | fetch questions, then `validateAnswers` → `ANSWERS_INVALID` | new, after 2 |
| 4 | capacity arm **simplifies** — its inner `findUnique` and early return are now dead (D-43a) | `R:1966-1978` |

> **Do not move the `P2002` catch (`R:1986-1997`), do not delete it, and do not add a second
> write.** D-43a's early return handles the *already signed up* case; the catch handles the
> genuine *two tabs raced past it* case. They are different facts and both are needed. Read
> mistake ④ and T-23.

The `event` row is read **before** the lock (`R:1945`) and its `capacity` is used **inside** it
(`R:1963`) — pre-existing, unchanged, and worth knowing: the questions are read *inside* the
lock precisely because they are the thing that can change while somebody is filling in the form.

### 5.5 `saveQuestions` — the reconciliation (D-45)

Pseudocode in D-45. Four things the coder must not optimise away:

- **`assertQuestionsEditable` runs INSIDE the lock**, not before it. Outside, a signup can land
  between the check and the write and the first answer is validated against a form that changed.
- **`maxID` is `max(existing) `, not `existing.length`.** A list of three questions whose ids are
  1, 2 and 7 must allocate 8.
- **Every field is written explicitly on every upsert**, including `options: []` and
  `maxLength: null`. T-12.
- **`order` is the array index**, rewritten for every kept question on every save. Dense, 0-based,
  no gaps — a sparse `order` makes `orderBy: { order: "asc" }` stable but meaningless.

### 5.6 `checkIn` — the twelve steps

In full in D-60. The three that get skipped under time pressure:

- **step 5**, `assertMayScan` — the only authorisation on the door;
- **step 6**, the window — without it a "door" is a check-in button that works forever;
- **step 8 before step 9**, the `wasSignedUp` snapshot — T-36.

### 5.7 Audit sites added

| Procedure | Action | `targetUserID` | `reason` |
|---|---|---|---|
| `undoCheckIn` | `event.checkin.undo` | **the attendee's canonical userID** | `event.title ?? undefined` |
| `exportAttendees` | `event.attendees.export` *(existing)* | — | now `` `${n} attendee(s), ${q} answer column(s)` `` |

Everything else in Parts B, C and D writes **no** audit row. C-3, restated in D-53 and D-70.

Every new audit call passes `targetCcaID: event.ccaID ?? undefined` — `AuditEntry.targetCcaID`
is `number | undefined`, never `number | null` (`admin.ts:410`), so `?? null` does not compile
and `as number` compiles and writes garbage. T-8, and it now appears at a sixth site.

---

## 6. File-by-file change list

**41 distinct files: 15 created, 23 modified, 3 deleted.**

*Counted by file, not by row: the four scripts appear in both their part's table and in §6.5,
and `routers/event.ts`, `EventManage.tsx` and `EventDetail.tsx` each appear in three of the
part tables. **The totals above are the distinct-file counts.** Plan 01 shipped its equivalent
line wrong and had to correct it in review; if your diff disagrees with 15/23/3, one of us is
wrong and it is worth two minutes to find out which.*

### 6.1 Part A — one authoring screen (0 created, 7 modified, 3 deleted)

| File | Change |
|---|---|
| `src/app/cca/_components/EventCreateForm.tsx` (141) | **DELETE** (D-28) |
| `src/app/cca/[ccaID]/events/new/page.tsx` (24) | **DELETE** |
| `src/app/admin/events/hall/new/page.tsx` (18) | **DELETE** |
| `src/app/cca/_components/EventsListPanel.tsx` (154) | "New event" becomes a mutation button (D-29). Drop the `newHref` prop. Absorb `EventCreateForm`'s four error strings (`:90-100`). Blank-draft row copy (D-31, §11.1) |
| `src/app/cca/[ccaID]/events/page.tsx` (28) | stop passing `newHref` |
| `src/app/admin/_components/events/HallEventsPanel.tsx` (40) | stop passing `newHref`; the heading copy at `:27-30` stays true |
| `src/app/cca/_components/EventManage.tsx` (1095) | the contract sentence above the footer (D-34, §11.1). `CancelEventButton`'s third copy variant (D-32). **`DetailsEditor` is otherwise untouched** (C-9) |
| `src/app/cca/_components/EventDetailsFields.tsx` (230) | `EMPTY_PROPOSAL` (`:33-41`) loses its only consumer — **delete the export**, keep the type |
| `src/server/api/routers/event.ts` | `create` reuse (D-30); `submitForReview` atomicity (D-37) |
| `package.json` | delete four scripts (D-80) |


### 6.2 Part B — questions (5 created, 9 modified)

**Reconciled against shipped Part A.** `EventCreateForm.tsx` and the two `/new` routes are
**already deleted** (`f8c9ffd`) — do not look for them and do not re-create them (D-40a).

| File | Change |
|---|---|
| `src/lib/schemas/eventQuestion.ts` | **CREATE** (§4.1) |
| `src/app/cca/_components/EventQuestionBuilder.tsx` | **CREATE.** Props `{ eventID: number }`. Mounts **inside `DetailsEditor`, which is already `"use client"`** — no new route, no new server/client boundary (**D-40a**). Reorder (up/down buttons, not drag — a drag library is a third dependency for one screen), type picker, options editor, required toggle, the PDPA line (D-51), the frozen state (D-44) |
| `src/app/events/_components/EventSignupQuestions.tsx` | **CREATE.** Props `{ questions, value, onChange, errors }` — **function props are fine here**: the parent `EventDetail.tsx:1` is `"use client"`. **No mutation of its own** — the parent owns `signup` |
| `scripts/remediation/create-event-phase2-indexes.mjs` | **CREATE — §9.2. Belongs to PR 2, not PR 3.** `EventQuestion`'s unique index is a Part B index and the code cannot ship without it (mistake ②). PR 2 runs it with the `EventQuestion` target only; PR 3 re-uses the same file for `EventAttendance`. *(The original draft listed this under §6.3/Part C, which would have shipped Part B with no index at all.)* |
| `scripts/remediation/purge-event-answers.mjs` | **CREATE** (D-52) |
| `prisma/schema.prisma` | §3.1, §3.2 |
| `src/lib/schemas/event.ts` | §4.3. **No `.default()` may be added to `createEventInput`** — D-45a |
| `src/server/api/routers/event.ts` | `saveQuestions`, `getQuestionsForOwner`, `getSignupAnswers`; edits to **`create` (D-39a — the question-count guard on the reuse branch, `R:566`)**, `signup` (D-43/D-43a), `getPublic`, `getForReview`, `getAttendees`, `exportAttendees` |
| `src/server/api/services/events.ts` | `assertQuestionsEditable` (D-44) |
| `src/app/cca/_components/EventManage.tsx` | mount `EventQuestionBuilder` inside `DetailsEditor` (`:141-432`), below the public description and **above** the footer actions (`:401-416`); new `mapError` entries (§11.2) |
| `src/app/events/_components/EventDetail.tsx` (231) | the signup branch at **`:178-190`** opens a Dialog holding `EventSignupQuestions` when `questions.length > 0`; unchanged one-click when it is 0. **The box is `sm:w-64` (`:144`) — the form goes in a Dialog, not in the box** |
| `src/app/cca/_components/EventAttendees.tsx` (132) | answer columns in the CSV (header built at `:31-40`) and in the table; the purged notice (D-50) |
| `src/app/events/_lib/format.ts` | `csvField` (`:116-121`) gains formula-injection neutralisation — **D-50a**, and note this is `src/app/events/_lib/`, **not** `src/lib/` |
| `src/app/admin/_components/events/EventReviewDetail.tsx` (493) | render the questions read-only above the decision panel (D-47) |

**`scripts/remediation/sweep-blank-event-drafts.mjs` — NO CODE CHANGE** (D-39b). Its condition 7
already refuses to delete a draft carrying `EventQuestion` rows. Do not "fix" it into a deletion.

### 6.3 Part C — attendance (8 created, 8 modified)

| File | Change |
|---|---|
| `src/lib/schemas/eventAttendance.ts` | **CREATE** (§4.2) |
| `src/server/api/services/eventQr.ts` | **CREATE.** `qrSecret`, `mintCheckInToken`, `verifyCheckInToken`, `currentWindow`. **Server-only** (D-55) |
| `src/app/cca/_components/EventDoorScanner.tsx` | **CREATE.** Props `{ eventID: number; backHref: string }` (D-62) |
| `src/app/cca/[ccaID]/events/[eventID]/door/page.tsx` | **CREATE.** Parse both segments with `parseCcaID`, exactly as the sibling route does (T-13) |
| `src/app/admin/events/hall/[eventID]/door/page.tsx` | **CREATE.** `backHref="/admin/events/hall/{id}"` |
| `src/app/events/_components/MyCheckInCode.tsx` | **CREATE.** Props `{ eventID: number }`. `qrcode.react` SVG, refetch at `QR_REFRESH_MS` |
| `prisma/schema.prisma` | §3.3 |
| `src/env.js` | `EVENT_QR_SECRET` — **server block AND `runtimeEnv`** (D-56) |
| `src/server/api/services/events.ts` | `assertAttendanceEnabled` (D-66) |
| `src/server/api/services/ccaMembers.ts` | `isLiveCcaMember` using **all** membership keys (D-61, T-32) |
| `src/server/api/services/roles.ts` | `AUDIT_ACTIONS` `:261-268` gains `"event.checkin.undo"` (D-70) |
| `src/server/api/routers/event.ts` | seven new procedures; `update` writes the three door fields in both scopes |
| `src/app/cca/_components/EventManage.tsx` | the "Door" section — window editor, scanner picker, link to the door page (D-68) |
| `src/app/events/_components/EventDetail.tsx` | mount `MyCheckInCode` in the "You're going" branch and behind the walk-in disclosure (D-67) |
| `package.json` | `qrcode.react@^4.2.0`, `jsqr@^1.4.0` (D-58) |
| `scripts/remediation/set-attendance-flag.mjs` | **CREATE** (D-66) |
| `scripts/remediation/create-event-phase2-indexes.mjs` | **NO CHANGE — created in PR 2 (§6.2).** PR 3 only *runs* it, with the `EventAttendance` target (§9.2, §12.4) |

### 6.4 Part D — dashboards (2 created, 3 modified)

| File | Change |
|---|---|
| `src/app/admin/_components/events/HallInsights.tsx` | **CREATE.** No props |
| `src/app/admin/events/insights/page.tsx` | **CREATE.** Renders it; inherits `/admin/events/layout.tsx`'s gate |
| `src/app/cca/_components/EventAnalytics.tsx` (114) | **extended**, not replaced (D-71) |
| `src/app/admin/events/page.tsx` (24) | one link to `/admin/events/insights` |
| `src/server/api/routers/event.ts` | `getAttendanceStats`, `getHallStats`, `attendanceStatus` |

### 6.5 Scripts and docs — the four new scripts restated in one place (4 created, 4 modified)

| File | Change |
|---|---|
| `scripts/remediation/create-event-phase2-indexes.mjs` | **CREATE** — §9 |
| `scripts/remediation/purge-event-answers.mjs` | **CREATE** — D-52 |
| `scripts/remediation/sweep-blank-event-drafts.mjs` | **CREATE** — D-33 |
| `scripts/remediation/set-attendance-flag.mjs` | **CREATE** — D-66 |
| `scripts/remediation/verify-events-schema.mjs` | checks [8][9][10] + informational (D-83) |
| `scripts/remediation/index-census.mjs` | `EXPECTED` gains two names (D-82) |
| `scripts/remediation/README.md` | Step 0 retraction + four new script entries (D-81) |
| `src/app/whats-new/page.tsx` | §11.6 |

### 6.6 Files listed as **NO CHANGE**, deliberately

So their absence from the diff is reviewable rather than an oversight:

`prisma/schema.prisma` `model Event` (§3.4) · `model Bookings` (§3.5) ·
`SCRC_HIDDEN_EVENT_FIELDS` (`event.ts:399-406`, D-69) · `toPublicCard` (`event.ts:270-298`,
D-46) · `services/ccaScope.ts` (`assertHeadsCca` must not learn about scanners — T-14) ·
`src/app/scrc/_components/EventsOversightPanel.tsx` (D-69) · `format.ts`'s `STATUS_META` (§2) ·
`src/app/admin/_components/AdminShell.tsx` (D-74) · `getSignupStats` (D-72) ·
`src/app/events/_components/EventsTimeline.tsx` (no question or attendance data on the timeline).

---

## 7. The disclosure census — who can read what, after this change

Plan 01's §7 was a *display* census (where "Hall" must render). This one is a **disclosure**
census, because Parts B and C add the first genuinely sensitive data this feature has held:
free-text answers about named residents, and a record of where a named resident physically was.

### 7.1 New data, and its reachable audience

| Data | Reachable by | Through | Audited? |
|---|---|---|---|
| `EventQuestion` rows (labels, options) | owning head; **JCRC reviewer**; **every authenticated resident** on a published event | `getQuestionsForOwner`, `getForReview`, `getPublic` | no — no PII on this model |
| `EventSignup.answers` | **owning head only** | `getAttendees`, `getSignupAnswers` | no (same class as `getAttendees` today) |
| `EventSignup.answers` in bulk, as a file | **owning head only** | `exportAttendees` | **YES** — existing `event.attendees.export` row, now naming the column count |
| `EventAttendance` rows | owning head; **nominated scanners** (live-revalidated) | `getDoorRoster`, `getAttendanceStats` | no — the row is its own record (D-70) |
| `EventAttendance` deletion | owning head; nominated scanners | `undoCheckIn` | **YES** — new `event.checkin.undo`, carrying `targetUserID` |
| Full matric of signups | **owning head only** — unchanged | `getAttendees`, `exportAttendees` | export only |
| **Last 4 of matric** | owning head **and nominated scanners** | `getDoorRoster` | no |
| Aggregate turnout per CCA | JCRC (`reviewEvents`, live) | `getHallStats` | no — counts, no names |

**The one widening in this plan is the `matricSuffix` row** — from "heads" to "heads and the
people they nominated". D-63 is the argument for why it is four characters and not the whole
number.

### 7.2 What the resident sees, and what they are told

A resident on a published event page can see the **questions** (they are being asked them) and
**their own** answers (they typed them). They cannot see anyone else's answers, anyone else's
attendance, or the signup list. `getPublic` returns `signupCount` and `mySignup` and has never
returned a roster (`event.ts:1728-1738`); that does not change.

They are told two things at the point of typing, both verbatim in §11.2: **who reads this**
(D-51's other half) and **how long it is kept** (D-52).

### 7.3 What the SCRC sees: exactly what it saw before

Restating D-69 as a census line so it is reviewable:

- **No column is added to `model Event`**, so `getForOversight`'s `{ ...event }` spread
  (`R:1842-1855`) exposes nothing new and `SCRC_HIDDEN_EVENT_FIELDS` (`R:403-411`) needs
  no edit.
- **`EventQuestion`, `EventAttendance` and `EventSignup.answers` are not read by any procedure
  on `oversightProcedure`.** Verify by grep at review time, not by trusting this line.
- `scannerUserIDs` **stays** blanked to `[]` in that list. It was added while inert (T-18); this
  is the phase that fills it, and removing it now would hand the hall office a directory of
  every door scanner in the hall.
- `EventsOversightPanel.tsx` names every field it renders and spreads nothing
  (`:58-82`), so nothing new appears there by accident either.

**Constraint 8 holds: SCRC gains no authorship and no scanning.** Not by a check, but because
no procedure it can reach writes anything.

### 7.4 Sites that are NOT part of this census

Recorded so nobody hunts for them:

- `EventsTimeline.tsx` — no question or attendance data reaches the timeline (D-46).
- `AuditLogTable.tsx:81-82` — still renders neither `targetCcaID` nor `targetEventID`, so the
  new `event.checkin.undo` row will show `—` in the Target column like every other event row.
  **Pre-existing (plan 01 C-4), still out of scope**, and now slightly more annoying because
  that row carries a `targetUserID` that *would* render. §15 records it.
- `listPublished` / `listMySignups` — `toPublicCard` is not widened (D-46).

---

## 8. The QR token, spelled out end to end

For the coder to check their implementation against, and for a reviewer to check the coder's.

```
SECRET      env.EVENT_QR_SECRET, ≥32 chars, server-only, read through qrSecret()
PURPOSE     "event-checkin"                       (domain separation, D-55)
WINDOW      30 seconds; w = floor(nowSec / 30)
PAYLOAD     `${PURPOSE}|${userID}|${w}`           (PIPE — mistake ⑤ / T-25)
TAG         base64url(HMAC-SHA256(SECRET, PAYLOAD)).slice(0, 32)      // 192 bits
WIRE        `RH1|${userID}|${TAG}`                (what the QR encodes)
MINT        event.myCheckInToken -> { token: TAG, expiresAt: (w+1)*30 }
CLIENT      refetches every 20s, so the displayed code is never the expiring one
VERIFY      recompute for w AND w-1; both compared with tokenMatches(); NO short-circuit
LIFETIME    30–60s from mint, by construction
```

### 8.1 What each property buys, and what it does not

| Property | Buys | Does NOT buy |
|---|---|---|
| Rotation every 30 s | a photographed code is dead in ≤60 s | it does not hide the userID (T-27) |
| `w` and `w-1` accepted | a scan across a rotation boundary works | it does not make a code last a minute *from the scan* |
| Purpose string first | a token minted here never verifies elsewhere | nothing, if a future feature forgets to use its own purpose |
| Pipe separator | `EXT:` ids cannot make two payloads collide | nothing, if someone "tidies" it to `:` |
| `timingSafeEqual` after a length check | no timing oracle, no throw on length mismatch | nothing, if either comparison is short-circuited |
| Server-only secret | the browser never holds it | nothing, if `eventQr.ts` is ever imported from `src/app/**` |

### 8.2 The three ways to get this wrong that still work in testing

1. **`return true` on the first matching window.** Correct answers, and a 30-second timing
   oracle at the boundary. Compute both, then `||`.
2. **Verifying against `nowSec` from the *client*.** Every timestamp in `checkIn` comes from the
   server clock. A client-supplied `nowSec` makes any token valid forever.
3. **Caching the mint.** `myCheckInToken` must not be memoised across the window boundary. Set
   the tRPC query's `staleTime: 0` and drive the refetch on an interval, or the resident's
   screen shows a dead code and the door blames the scanner.

---

## 9. THE INDEX-CREATION PROCEDURE

> **This is the single most dangerous operation in this plan.** It gets its own section, its
> own script, and a census on both sides of it. Read `create-auth-allowlist.mjs` before writing
> a line of `create-event-phase2-indexes.mjs`; it is the same job, done once, correctly.

### 9.0 Why an index is needed at all, and why `db push` is not the way to get one

Two indexes, both compound-unique:

| Collection | Index | Key | What breaks without it |
|---|---|---|---|
| `EventQuestion` | `event_question` | `{ eventID: 1, questionID: 1 }` | The lock is advisory and reclaimable after 30 s (`services/events.ts:110`). Without the index, a stale-lock reclaim mid-save writes two questions with the same `questionID` and every answer to either one is ambiguous. **No error anywhere.** |
| `EventAttendance` | `event_attendee` | `{ eventID: 1, userID: 1 }` | A re-scan writes a second row. The count is wrong, the turnout percentage is wrong, and `undoCheckIn` deletes one of two. **No error anywhere.** |

`prisma db push` would create both. It would **also drop `User.email_unique_ci`**, the
case-insensitive unique index that is the only thing preventing two rows differing solely in
letter case from becoming two accounts for one human — because Prisma cannot represent a
collation index in the schema, sees it as "not in schema", and removes it without warning and
without `--accept-data-loss`. It has been dropped and restored on this cluster before. The
remediation trail is four scripts long (`merge-by-canonical.mjs`, `fix-claresta-duplicate.mjs`,
`fix-lgd-duplicate.mjs`, `merge-mingyuan-duplicate.mjs`).

**So: `createIndexes`, from a guarded script, with a census on both sides.**

### 9.1 Index census — BEFORE (blocking)

```bash
node scripts/remediation/index-census.mjs > census-before.txt
```

**Redirect, never pipe** (§0.0). **Exit 0 is required.** A non-zero exit means either
`email_unique_ci` is already missing — in which case restore it with §9.6's one-liner before
anything else touches the cluster — or a read failed, which makes the census PARTIAL and
useless as a baseline.

**The expected `Event*` picture before PR 2, carried forward from plan 01 §0.6 and UNVERIFIED
(C-5):**

| Collection | Index | Unique |
|---|---|---|
| `Event` | `_id_`, `eventID`, `cca_status`, `status_start`, `start` | `eventID` only |
| `EventSignup` | `_id_`, `event_user`, `eventID`, `userID` | `event_user` only |
| `EventLock` | `_id_`, `EventLock_key_key` | yes |
| `Counter` | `_id_`, `Counter_key_key` | yes |
| `User` | … + **`email_unique_ci`**, unique, collation `en`/strength 2 | yes |
| `EventQuestion` | **(absent)** | — |
| `EventAttendance` | **(absent)** | — |

`(absent)` for the two new ones is the correct pre-rollout state, exactly as `AuthAllowlist`
was before its own script ran.

### 9.2 `scripts/remediation/create-event-phase2-indexes.mjs`

> **CORRECTED — THE SCRIPT MUST TAKE AN EXPLICIT TARGET, AND MUST REFUSE TO RUN WITHOUT ONE.**
>
> The original draft put both collections in one unconditional `TARGETS` list. That contradicts
> the rollout in two directions and would have been discovered mid-deploy:
>
> - §12.3 (**PR 2**) tells the operator the census diff should show **"ONLY the `EventQuestion`
>   lines"**. An unconditional script creates `EventAttendance` too, so the diff shows lines the
>   operator was told to treat as a red flag — during the one step whose entire purpose is
>   spotting unexpected index changes. The likely reaction is to stop a correct deploy; the worse
>   reaction is to learn that this diff is noisy and start skimming it.
> - §12.4 (**PR 3**) step 3 then re-runs the script to create `EventAttendance` — which already
>   exists, so it reports `68 IndexAlreadyExists` and PR 3's census diff is **empty**. §10.5 check
>   `[9]` is scheduled to become blocking at PR 3 on the strength of a step that did nothing.
> - And it creates an index on a collection whose model does not exist until Part C, which §9.1's
>   own table lists as **`(absent)`** at that point.
>
> **The target is named on the command line and there is no default.**

```bash
# PR 2 (Part B) — questions
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion            # DRY RUN
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit   # apply

# PR 3 (Part C) — attendance
node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit
```

**Named with no argument, it prints usage and exits non-zero.** It must never guess, and it must
never do both because someone forgot to say which.

**Modelled on `create-auth-allowlist.mjs`, line for line.** What it must carry:

```js
const TARGETS = {
  EventQuestion: [
    { key: { eventID: 1, questionID: 1 }, name: "event_question", unique: true },
  ],
  EventAttendance: [
    { key: { eventID: 1, userID: 1 },     name: "event_attendee",  unique: true },
  ],
};

// NO DEFAULT. An unrecognised or missing name exits 2 with usage — it must never
// silently fall back to "all", which is what makes PR 2's census diff readable.
const target = process.argv[2];
if (!target || !(target in TARGETS)) { usage(); process.exit(2); }
```

**PART B ONLY NEEDS `EventQuestion`.** The `EventAttendance` entry ships in the same file because
the file is created in PR 2 (§6.2) and Part C should not have to edit it — but **PR 2 must not
run it**, and the VERIFY pass below checks only the target it was given.

- **`runCmd` inspects the reply, it does not rely on a throw.** `$runCommandRaw` returns errors
  **as data**: a failed command resolves `{ ok: 0, code, errmsg }` and a partially-failed one
  resolves `{ ok: 1, writeErrors: [...] }`. Neither throws. A script built on `try/catch` alone
  reports SUCCESS on a command that did nothing. This is written out at
  `create-auth-allowlist.mjs:80-95` and it is the reason that script exists in the shape it does.
- **The idempotency map, verbatim from `create-auth-allowlist.mjs:114-121`:** `48
  NamespaceExists`, `68 IndexAlreadyExists`, `85 IndexOptionsConflict`, `86
  IndexKeySpecsConflict` are "someone got here first" and are reported, not failed. **`11000`
  (E11000) is NEVER swallowed** — it means rows already violate the uniqueness being requested,
  the index was not created, and the data must be fixed first.
- **A VERIFY pass decides the exit code.** After committing, re-read `listIndexes` for both
  collections and require each index to exist **with `unique: true`, matched on the KEY PATTERN
  and not on the name.** A name match reports a false failure when an index was made by a
  different route — the rule `verify-events-schema.mjs:152` already states.
- **It creates the collections explicitly** (`create`), then the indexes. Mongo would create
  them implicitly on `createIndexes`, but an explicit `create` gives a `48 NamespaceExists` on a
  re-run, which is a clearer signal than silence.
- **`process.exitCode`, never `process.exit()`**, so `.finally(() => db.$disconnect())` runs and
  stdout flushes — the discipline every script in this directory follows.
- **It touches nothing else.** No `Event`, no `EventSignup`, no `User`, no `Counter`. If the
  diff of this script mentions any of those, it is the wrong script.

### 9.3 Index census — AFTER (blocking)

```bash
node scripts/remediation/index-census.mjs > census-after.txt
diff census-before.txt census-after.txt
```

**The ONLY acceptable diff, for PR 2:**

```
+ EventQuestion    event_question  {"eventID":1,"questionID":1}  UNIQUE
+ EventQuestion    _id_            {"_id":1}
- EventQuestion    (absent)
```

**for PR 3:**

```
+ EventAttendance  event_attendee  {"eventID":1,"userID":1}  UNIQUE
+ EventAttendance  _id_            {"_id":1}
- EventAttendance  (absent)
```

**Any REMOVED line is a dropped index and the cluster must take no further writes until it is
restored.** Any line about `User`, `Event`, `EventSignup`, `Bookings` or `Counter` in either
direction means something other than this script ran.

### 9.4 The flag cannot be switched on without the indexes

`set-attendance-flag.mjs on --commit` reads `listIndexes` for both collections and **refuses**
unless both compound-unique indexes are present (D-66). This is the control that makes mistake
② non-silent: the failure mode "we shipped without the index" becomes "the switch would not
turn on and said why", instead of "the counts were quietly wrong for a term".

There is no equivalent gate for Part B, because Part B has no flag — which is why
`verify-events-schema.mjs` check [8] is blocking after PR 2 and is in the §13 checklist.

### 9.5 Rollback

| Situation | Move |
|---|---|
| The index script failed partway | Re-run it. It is idempotent by construction (§9.2). |
| An index was created with the wrong key | `dropIndex` by **name**, then re-run. Do this deliberately, by hand, with the census open. |
| The feature is wrong and must go | **Leave the indexes.** They are inert on an empty collection and dropping an index is the operation this whole section is about avoiding. Flip the flag off (Part C) or revert the deploy (Part B). |
| `email_unique_ci` is missing from the census | **STOP.** §9.6, before anything else. |

### 9.6 Restoring `email_unique_ci`

```js
db.runCommand({ createIndexes: "User", indexes: [{
  key: { email: 1 }, name: "email_unique_ci", unique: true,
  collation: { locale: "en", strength: 2 } }] })
```

**It will fail with `E11000` if case-duplicate accounts formed while it was absent. That failure
is the point** — it is the detector, not a problem with the command. `merge-by-canonical.mjs`
(dry run first) is the remedy; then re-run the `createIndexes`.

---

## 10. Scripts

Four new, three edited. Every one of them: **dry run by default**, `isCommit()` from
`./lib/rbac.mjs`, `process.exitCode` never `process.exit()`, reply inspection over `try/catch`,
and a header that says what it can and cannot check.

### 10.1 `create-event-phase2-indexes.mjs` — CREATE

§9.2. The only script here that writes to the cluster's *structure*.

### 10.2 `purge-event-answers.mjs` — CREATE (D-52 layer 2)

```
node scripts/remediation/purge-event-answers.mjs             # dry run
node scripts/remediation/purge-event-answers.mjs --commit    # erase
```

Selects `Event` where `answersPurgedAt == null` **and** `(endTime ?? startTime)` is more than
`EVENT_ANSWER_RETENTION_DAYS` (60) in the past. For each: `updateMany` the event's
`EventSignup` rows to `$set { answers: [] }`, then `update` the `Event` to stamp
`answersPurgedAt`.

**In that order.** Stamping first and clearing second leaves a window where the event *claims*
its answers are purged and they are not — which is precisely the state
`verify-events-schema.mjs` check [10] exists to detect, and it should never be reachable from
the script's own happy path.

**Events with no date on file are skipped**, and the dry run reports them separately. There is
nothing to count 60 days from, and guessing would delete answers early.

**Signup rows are never deleted.** The header says so in capitals: the row is what makes the
signup count and the attendance count survive a purge, and it is the reason Part D still works
on a purged event.

**Header must say, in the first paragraph: "Nothing runs this automatically. There is no cron
in this repository."** followed by what the app guarantees regardless (D-52 layer 1), so an
operator reading it understands what they are and are not the last line of defence for.

### 10.3 `sweep-blank-event-drafts.mjs` — CREATE (D-33)

Nine conditions, all nine required, in D-33's table. **The only place an `Event` row is ever
deleted, and it is unreachable from the application.** Does not touch `Counter`.

### 10.4 `set-attendance-flag.mjs` — CREATE (D-66)

Modelled on `set-events-flag.mjs`, including its retracted-`db push` header. Plus the index
gate in §9.4.

### 10.5 `verify-events-schema.mjs` — EDIT (D-83)

Checks [8], [9], [10] plus four informational lines. Still read-only, still refuses `--commit`.

### 10.6 `index-census.mjs` — EDIT (D-82)

Two names into `EXPECTED`. Not into the blocking subset.

### 10.7 `README.md` — EDIT (D-81)

Step 0 retraction, plus an entry for each of the four new scripts saying **who runs it and
when**.

---

## 11. Verbatim copy

**Every string below is final. Do not paraphrase, do not "improve", and do not invent one that
is missing — ask instead.** This repo has had **six** copy-drift incidents by its own count,
plus the seventh found by this plan (C-14). Every string here that enumerates a consequence was
written against the decision it describes, by number.

**Typography.** Match the existing files: curly apostrophes (`’` — `EventManage.tsx:596`,
`EventReviewDetail.tsx:148`), curly quotes (`“ ”`), en dashes in ranges (`format.ts:49-68`),
em dashes in prose. In JSX write `&rsquo;` where the surrounding file does.

**One inconsistency to fix while you are here.** `EventReviewDetail.tsx:134`'s fallback uses a
**straight** apostrophe — `"That didn't go through. Try again."` — while `mapCancelError` at
`:392` uses a curly one for the same words. `EventDetail.tsx:52`'s
`"That didn't work. Try again."` is straight too. Make all three curly.

---

### 11.1 Part A — the single authoring screen

**`EventsListPanel.tsx` — the "New event" button** (replacing the `Link` at `:67-72`):

> New event

Pending label:

> Creating…

Error strings, moved from `EventCreateForm.tsx:90-100` and unchanged:

| Code | Message |
|---|---|
| `NO_SUCH_CCA` | This CCA no longer exists. |
| `NOT_A_HEAD_OF_THIS_CCA` | You’re no longer a head of this CCA. |
| `CAPABILITY_REQUIRED:manageHallEvents` | You can’t manage hall events. |
| `EVENTS_DISABLED` | Events aren’t switched on yet. |
| *(fallback)* | That didn’t work. Try again. |

**`EventsListPanel.tsx` — a blank draft row** (D-31), replacing the `Finish and submit` line at
`:120-124` **when the row has no title**:

> Nothing filled in yet

> Start filling this in

A `draft` row **with** a title keeps today's string, unchanged:

> Finish and submit

**Empty state** (`:87-91`) — unchanged, both branches. It is still true: the head does add the
details, a banner and a description, and the JCRC does review it.

**`EventManage.tsx` — the contract sentence** (D-34). New, directly above the footer buttons at
`:335`, and rendered **only** for a CCA event (`!isHallEvent`):

> This is everything JCRC sees. When they approve it, it goes live on the residents’ timeline straight away — there’s nothing more for you to do.

For a hall event (`isHallEvent`) the same slot reads:

> This is the whole event. Register and publish puts it on the residents’ timeline straight away.

**Why this sentence and not a relabelled button.** D-34. The head's model is "publish → review →
done". The button is honest about the first arrow; this sentence is what tells them the third
step needs nothing from them, which is the half of the loop the app has never stated on this
screen.

**Footer buttons** (`:336-356`) — unchanged:

> Save and finish later · Saving… · Submit for review · Submitting…

and for a hall event, unchanged:

> Register and publish · Publishing…

**`CancelEventButton`'s third variant** (D-32) — `EventManage.tsx:751-755` gains a branch for a
draft with no title:

> Cancel this event?

> There’s nothing in it yet, so nothing is lost. It stays on your list as cancelled.

The two existing variants are unchanged:

*published:* "It comes off the residents’ timeline, everyone who signed up loses their place, and the facility booking is released. This can’t be undone."

*draft / submitted / changes_requested with content:* "It won’t go ahead and can’t be resubmitted. This can’t be undone."

**Error map** (`EventManage.tsx:52-95`) gains nothing in Part A. `NOT_SUBMITTABLE` (`:80-81`) is
already there and its copy is already correct for D-37's new refusals.

---

### 11.2 Part B — questions

**`EventQuestionBuilder.tsx` — section heading and intro:**

> Signup questions

> Ask residents anything you need when they sign up. Leave this empty and signing up stays one tap.

**The PDPA line** (D-51) — rendered **above** the "Add a question" button, in a bordered amber
note, always visible, never behind a disclosure:

> Careful what you ask for

> Answers are read by whoever heads this CCA — this year and next. Don’t ask about allergies, dietary needs, medical conditions or anything else about someone’s health unless the event genuinely can’t run without it, and say why in the question.

**Add / reorder / remove:**

> Add a question

> Move up · Move down · Remove

**Per-question fields:**

> Question · Help text (optional) · Required · Options · Add an option

Type picker labels (`QUESTION_TYPE_COPY`, D-40 — a `Record` over the union, so a new type
without copy is a compile error):

| Key | Label | Hint |
|---|---|---|
| `short_text` | Short answer | One line of text |
| `long_text` | Long answer | A paragraph |
| `single_choice` | Pick one | A list where they choose one |
| `multi_choice` | Pick several | A list where they can choose more than one |
| `checkbox` | Tick box | A single yes/no tick |
| `number` | Number | Digits only |
| `date` | Date | A calendar date, no time |

**Builder validation messages** (from `questionDraftSchema`, D-41):

> Every question needs a label

> A choice question needs at least two options

> Only choice questions have options

> Two options can’t be the same

> Only text questions have a length limit

**The frozen state** (D-44) — replaces the whole builder when `frozen` is true:

> These questions are locked

> {n} {people have} already signed up and answered these questions. Changing them now would leave those answers pointing at questions that no longer exist, so the form is fixed for this event. If you need a different form, cancel this event and duplicate it.

*(`{people have}` is `person has` for n = 1, `people have` otherwise. Match the pluralisation
shape at `EventAttendees.tsx:66` and `EventsListPanel.tsx:114`.)*

**When the event is in the review queue**, the builder is not mounted at all — the `submitted`
panel replaces the whole editor (`EventManage.tsx:1043-1078`), which is existing behaviour and is
why `EVENT_LOCKED` is unreachable here.

**Server error strings** (`EventManage.tsx`'s `mapError`, new entries):

| Code | Message |
|---|---|
| `QUESTIONS_FROZEN` | Someone signed up while you were editing, so the questions are locked now. Reload the page. |
| `NO_SUCH_QUESTION` | One of these questions was removed by another head. Reload the page. |

`QUESTIONS_FROZEN`'s copy passes the test §8.10 of plan 01 set: **retrying can never succeed**,
so it must not fall through to "Try again."

---

**`EventSignupQuestions.tsx` — the resident's form**, in a Dialog (D-46, §6.2):

Title:

> A few questions first

Sub-line:

> {CCA or Hall} needs these before you can sign up.

**The retention line** (D-52) — directly under the sub-line, **above the first field**, so it is
read before anything is typed:

> Your answers go to this event’s organisers and to JCRC. They stop being available 60 days after the event ends.

**Why this wording and not "are deleted after 60 days".** D-52. What the *application*
guarantees unconditionally is that it stops handing them out — the read cutoff needs no
operator and cannot be forgotten. What makes them stop *existing* is a script somebody runs.
"Stop being available" is exactly true of the guarantee the code makes. **Do not strengthen this
sentence to promise deletion unless and until something automatic performs it** — a retention
promise nothing executes is worse than not making it.

Required marker and its error:

> Required

> Please answer this

Type-specific errors from `validateAnswers` (D-41b):

| Situation | Message |
|---|---|
| required, empty | Please answer this |
| text over `maxLength` | Keep this under {n} characters |
| `number`, unparseable | Please enter a number |
| `date`, not `YYYY-MM-DD` | Please pick a date |
| `single_choice` / `multi_choice`, value not in `options` | That option isn’t available any more. Reload the page. |
| more than one value on a single-choice | Pick just one |
| a `questionID` not on this event | This form has changed. Reload the page. |

Buttons:

> Cancel · Sign up · Signing up…

**Server refusal** (`EventDetail.tsx`'s error map, new entry):

| Code | Message |
|---|---|
| `ANSWERS_INVALID` | Some answers need fixing — check the form above. |

The existing four are unchanged: `MATRIC_REQUIRED` → "Add your matric number to sign up.",
`EVENT_FULL` → "This event just filled up.", `SIGNUP_CLOSED` → "Signups have closed for this
event.", fallback → "That didn’t work. Try again."

**The "You’re going" branch** (`EventDetail.tsx:147-163`) gains **no** "edit my answers" link
(D-48) and **must not** imply the answers can be changed. It gains one line, only when the
event has questions:

> Your answers are saved. To change them, cancel your signup and sign up again.

---

**`EventAttendees.tsx` — the head's table and export** (D-50):

Column headers are the question **labels**, verbatim, appended after `Signed up at`.

When `answersAreRetained` is false, the answers section of the table is replaced by:

> Answers are no longer available

> This event ended more than 60 days ago, so the answers are no longer shown or exported. The signup and attendance counts are unaffected.

And in the CSV, every answer cell of such an event is the literal:

> —

**Not blank.** T-29: a blank cell says "this person didn’t answer", which is a different and
false claim.

**Export button** — unchanged (`:74-75`): `Download CSV` / `Preparing…`. Its warning line at
`:79-84` is unchanged. **A second warning is added when the export carries answers:**

> This file includes everyone’s answers. Downloading it is recorded in the audit log.

That sentence is true of both halves: `exportAttendees` already audits (`R:1381-1388`),
and D-53 puts the answer-column count in the row.

---

**`EventReviewDetail.tsx` — the reviewer sees the questions** (D-47). New read-only block above
the decision panel, rendered only when the event has questions:

> What residents will be asked

> {n} question{s}. Residents answer these when they sign up, and only this CCA’s heads can read the answers.

For a hall event, the last clause reads:

> …and only JCRC can read the answers.

---

### 11.3 Part C — attendance

**`EventManage.tsx` — the "Door" section** (D-65, D-68):

> Door check-in

> Scan residents in at the door. Attendance is for your own records — it doesn’t affect anyone’s ability to sign up for anything.

Window fields:

> Check-in opens · Check-in closes

> Leave these blank to use an hour before the start and an hour after the end.

Scanner picker:

> Who can scan

> Pick people from your CCA. They can scan at this event only, and only while they’re still in the CCA.

For a hall event:

> Pick JCRC members. They can scan at this event only.

Link to the door page:

> Open the door scanner

---

**`EventDoorScanner.tsx`:**

Heading and count:

> Door check-in — {title}

> {n} checked in

Camera control:

> Start camera · Stop camera

Confirmation card, on the list:

> {displayName}

> On the list

Confirmation card, walk-in:

> {displayName}

> Not on the list — checked in anyway

Already scanned:

> {displayName}

> Already checked in at {time}

Undo:

> Undo

> Undone. {displayName} is no longer checked in.

Manual list:

> Or find someone by name

> {n} signed up · Check in · Checked in

> Someone not on the list

Walk-in resolver:

> Type a full matric number, or three letters of a name.

> No one matched. Check the spelling, or try the full matric number.

> Too many matched. Type more of the name, or use the full matric number.

**The camera-permission branches** (D-62, T-33) — every one of these is rendered **beside** the
always-visible manual list, never instead of the page:

*No `getUserMedia` at all, or the page is not a secure context:*

> This browser can’t use the camera

> Open this page in Safari or Chrome and try again. You can still check people in from the list below.

*`getUserMedia` threw `NotAllowedError`:*

> Camera access was blocked

> If you opened this from a link inside another app — Telegram, Instagram, WhatsApp — that app’s built-in browser usually refuses the camera. Open it in Safari or Chrome instead. You can still check people in from the list below.

*`NotFoundError` / `NotReadableError`:*

> No camera available

> Something else may be using it. You can still check people in from the list below.

**Why the in-app-browser sentence names the apps.** A committee member who tapped a link in a
group chat has no idea they are in an embedded browser; "open in Safari" is meaningless advice
until they know why. And **the manual list is mentioned in every single branch**, because the
door does not stop working.

**Server error strings on the door page:**

| Code | Message |
|---|---|
| `BAD_QR` | That code didn’t work. Ask them to refresh their code and try again. |
| `DOOR_NOT_OPEN` | Check-in hasn’t opened yet — it opens at {time}. |
| `DOOR_CLOSED` | Check-in closed at {time}. |
| `NOT_A_SCANNER` | You’re not set as a scanner for this event any more. |
| `NOT_PUBLISHED` | This event isn’t live, so nobody can be checked in. |
| `ATTENDANCE_DISABLED` | Door check-in isn’t switched on. |
| `ATTENDANCE_NOT_CONFIGURED` | Door check-in isn’t set up on this server yet. An admin needs to set EVENT_QR_SECRET. |
| `NO_SUCH_EVENT` | This event no longer exists. |
| *(fallback)* | That didn’t go through. Try again. |

**`BAD_QR` is deliberately one message for three causes** — unparseable, wrong signature, and
expired. D-57: a distinct "expired" message would tell someone probing the door which userIDs
exist. The remedy the scanner needs is the same in all three cases: refresh and re-scan.

---

**`MyCheckInCode.tsx` — the resident's QR:**

> Your check-in code

> Show this at the door. It refreshes every few seconds — that’s normal.

Walk-in disclosure (visible only while the door window is open):

> Show my check-in code

Failure:

> Your code couldn’t load. Reload the page.

**Do not display the token, the userID or a countdown.** A countdown invites people to hold up
a code that is about to die; the refresh is silent and the scanner accepts the previous window
anyway (D-55).

---

### 11.4 Part D — dashboards

**`EventAnalytics.tsx`, attendance section:**

> Turnout

> {checkedIn} of {signedUp} signed up · {walkIns} walk-in{s}

> Attendance is for your records only. It has no effect on anyone’s bookings, signups or anything else.

Live, during the door window:

> Checking in now

No data:

> Nobody was scanned at this event, so there’s no turnout to show.

No-show list:

> Didn’t turn up

> {n} of the people who signed up weren’t scanned in. They may still have come — this only counts people who were scanned.

**That second sentence is not hedging, it is accuracy.** A person who walked past an unattended
door is indistinguishable from a person who stayed home, and a list headed "Didn’t turn up"
with no caveat is a claim about individuals that the data does not support.

When attendance is off (`attendanceStatus.enabled === false`, `reason === "flag"`): **render
nothing.** No heading, no empty chart, no error.

When `reason === "secret"`:

> Door check-in isn’t set up

> The EVENT_QR_SECRET setting is missing on this server. An admin needs to add it before check-in will work.

**`HallInsights.tsx`:**

> Events across the hall

> Every event between {from} and {to}. Change the dates to look at a different stretch.

> Attendance is informational. Nothing in this app uses it to allow or refuse anything.

Panels:

> Turnout · Who’s running events · How busy the calendar is

Table headers:

> Owner · Event · Date · Status · Signed up · Turned up · Walk-ins · Turnout

Turnout cell with no attendance data — the literal:

> —

**Never `0%`** (D-76). An event nobody scanned has no data; an event nobody attended has a
number. Printing `0%` for the first is a false statement about a CCA, on a page the JCRC reads.

Empty range:

> No events in this range.

---

### 11.5 New error codes, collected

So the coder can check the map is complete. **The test for whether a code belongs in a UI map
is not "is it common" but "can retrying ever work?"** — if not, the generic fallback is lying
(plan 01 §8.10).

| Code | Thrown by | Retry can work? | Mapped in |
|---|---|---|---|
| `QUESTIONS_FROZEN` | `saveQuestions` | **no** | `EventManage` |
| `NO_SUCH_QUESTION` | `saveQuestions` | **no** | `EventManage` |
| `ANSWERS_INVALID` | `signup` | yes, after a fix | `EventDetail` |
| `BAD_QR` | `checkIn` | yes, after a refresh | `EventDoorScanner` |
| `DOOR_NOT_OPEN` | `checkIn`, `checkInManual` | later, yes | `EventDoorScanner` |
| `DOOR_CLOSED` | `checkIn`, `checkInManual` | **no** | `EventDoorScanner` |
| `NOT_A_SCANNER` | every door procedure | **no** | `EventDoorScanner` |
| `NOT_PUBLISHED` | every door procedure | **no** | `EventDoorScanner` |
| `ATTENDANCE_DISABLED` | every attendance procedure | **no** | `EventDoorScanner`, `EventAnalytics` |
| `ATTENDANCE_NOT_CONFIGURED` | `qrSecret()` | **no** | `EventDoorScanner`, `EventAnalytics` |

---

### 11.6 `whats-new/page.tsx`

| Line | Now | Becomes | Ships with |
|---|---|---|---|
| `:231` | **CCAs create, JCRC approves.** Fill in the whole event — details, banner, description — and JCRC reviews the finished thing. Approving puts it straight on the timeline. | **CCAs create, JCRC approves.** Fill everything in on one screen — details, banner, description, and any questions you want to ask — then send it for review. Approving puts it straight on the timeline. | A + B |
| `:234` | **One-tap sign-up.** Sign up or change your mind in a tap. Events fill up fairly, with no accidental double sign-ups. | **Sign up in a tap.** One tap for most events, or a short form when the organisers need to ask you something. Events fill up fairly, with no accidental double sign-ups. | B (C-15) |
| new, after `:234` | — | **Scan in at the door.** Show your code, the committee scans it, and that’s attendance done. It’s for their records only — it doesn’t affect anything else. | C |
| `:292` | **Put on events** — add the details, banner and photos, and it goes live the moment JCRC approves. | **Put on events** — one screen for the details, banner, photos and signup questions, and it goes live the moment JCRC approves. | A + B |
| `:309` | **Find and attend events** — scroll the timeline and sign up in a tap. | *(unchanged — still true)* | — |
| `:383` | One-tap sign-up with fair limits | Sign up in a tap, or answer a short form | B (C-15) |
| `:385` | **Turnout stats for heads** | *(unchanged — and it becomes TRUE for the first time)* | D (C-14) |
| new, after `:385` | — | QR check-in at the door | C |

**`:385` is the one to watch.** It is false today (C-14). **If Part D slips, delete the line
rather than leaving it** — a claim that has been false for a term and is about to become true
is still false for that term, and this file is the one the repo's drift incidents were about.

**`:232`, `:271`, `:272`, `:273-274`, `:377-384`'s remaining items — unchanged.** Verified line
by line against the shipped behaviour while writing this plan.

---

## 12. Rollout

Four deploys, in D-78's order. **The database step is `npx prisma generate` for every one of
them, plus `createIndexes` from a guarded script for PRs 2 and 3. There is no `db push` and no
`migrate` at any point.**

### 12.1 Pre-flight, before PR 1 — BLOCKING

Because C-5 means nothing about the data was verified while this plan was written:

```bash
node scripts/remediation/verify-events-schema.mjs > events-before.txt   # exit 0 required
node scripts/remediation/index-census.mjs        > census-before.txt    # exit 0 required
```

**Then read `events-before.txt` and confirm, by eye:**

| Reading | Expected | If not |
|---|---|---|
| `Event` total | 0, or a small number of real events | If large, D-30's reuse and D-33's sweep still work but **re-read D-33's condition 9** before running the sweep |
| `Event` where `ccaID: null` | any | informational; §9.8 of plan 01 needs it for a rollback |
| `EventSignup` total | **0** | If non-zero, **STOP on D-49**: those rows have no `answers` key and §13.2 step 2 is no longer a pre-emptive check, it is a live migration question |
| `EventLock` total | 0 at rest | non-zero means a leaked lock; investigate before adding D-45's traffic to it |
| distinct `Event.status` | ⊆ the six | anything else is a row `normalizeStatus` silently reads as `draft` |
| `User.email_unique_ci` | present, unique, collation `en`/2 | **STOP.** §9.6 before anything else touches the cluster |

**If any of these surprises you, say so and re-plan rather than proceeding.** That instruction
is here because this plan could not run these commands itself.

### 12.2 PR 1 — Part A

```bash
npx prisma generate      # no schema change in PR 1; run it anyway so the tree is consistent
npx tsc --noEmit         # zero errors
npm run lint             # zero new warnings
npm run build            # must succeed
```

Deploy. **No flag, no index, no env var, no script.** Then §13.3's browser pass, which is the
only thing that can catch mistake ③.

### 12.3 PR 2 — Part B

```bash
# 1. schema
npx prisma generate

# 2. the index — NAME THE TARGET, DRY RUN FIRST, and read the output.
#    EventQuestion ONLY. Do NOT create EventAttendance here: Part C's model does
#    not exist yet, and an unexpected line in step 3's diff is exactly the signal
#    step 3 exists to detect (§9.2).
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion
node scripts/remediation/create-event-phase2-indexes.mjs EventQuestion --commit

# 3. prove it
node scripts/remediation/index-census.mjs > census-after.txt
diff census-before.txt census-after.txt        # ONLY the EventQuestion lines, §9.3
node scripts/remediation/verify-events-schema.mjs   # check [8] now blocking

# 4. build and deploy
npx tsc --noEmit && npm run lint && npm run build
```

**The index script runs BEFORE the deploy.** An index created after the code has been taking
writes is an index that may fail with `E11000` on data the code already wrote.

**There is no flag for Part B.** Questions appear in the builder the moment the deploy lands.
That is deliberate — an empty question list is indistinguishable from the current behaviour, so
the feature is invisible until a head uses it, and gating it would mean a flag nobody would ever
remember to turn on. The rollback lever is a Vercel revert.

### 12.4 PR 3 — Part C, and the order here is BLOCKING

```
1. Set EVENT_QR_SECRET in Vercel (Production AND Preview).  openssl rand -base64 48
2. Redeploy so the env var is live.
3. node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance
   node scripts/remediation/create-event-phase2-indexes.mjs EventAttendance --commit
   # The script was CREATED in PR 2 but PR 2 ran it only for EventQuestion (§9.2),
   # so this is the first time this index is created and the diff must be non-empty.
4. node scripts/remediation/index-census.mjs > census-after.txt ; diff
   node scripts/remediation/verify-events-schema.mjs                  # check [9] now blocking
5. Confirm event.attendanceStatus reports { enabled: false, reason: "flag" }
   — NOT reason: "secret". If it says "secret", step 1 did not take.
6. node scripts/remediation/set-attendance-flag.mjs on --commit
   — it REFUSES unless both indexes exist (§9.4). That refusal is the point.
7. One trial event. One door. One evening. Then decide.
```

**Steps 1–2 before step 6, always.** In that order the flag can never be on while the secret is
absent, which is the one state where the door looks available and cannot work.

### 12.5 PR 4 — Part D

`prisma generate`, typecheck, build, deploy. No schema, no index, no flag, no dependency.

**`whats-new:385` becomes true here** (C-14). If PR 4 slips past the term, delete the line
(§11.6).

### 12.6 Rollback, per part, cheapest first

| Part | Lever | Cost |
|---|---|---|
| **C** | `set-attendance-flag.mjs off --commit` | Seconds, no deploy. Every attendance procedure goes inert within the 15 s flag TTL (`services/events.ts:19`). `EventAttendance` rows stay — they are a record, and a switched-off feature must not erase what it recorded. |
| **All** | `set-events-flag.mjs off --commit` | Seconds. The whole Events surface, including everything in this plan. The correct first move for any events incident. |
| **A, B, D** | Vercel revert | Minutes. |
| **B — after the revert** | Nothing to do about the data: an `EventSignup` row carrying `answers` reads fine on the old client, which simply ignores the field. `EventQuestion` rows become unreachable and inert. | — |
| **C — after the revert** | Same: `EventAttendance` rows become unreachable and inert. | — |
| **Indexes** | **Leave them.** Inert on an empty collection, and dropping an index is the operation §9 exists to avoid. | — |

**There is no data-loss rollback risk in any part.** No part of this plan deletes anything a
user created, except `sweep-blank-event-drafts.mjs` (nine guards, D-33) and
`purge-event-answers.mjs` (which is the point, D-52).

---

## 13. Test plan

### 13.1 What the coder verifies STATICALLY, before handing over

```bash
npx prisma generate          # must precede tsc — it writes the types
npx tsc --noEmit             # ZERO errors
npm run lint                 # ZERO new warnings
npm run build                # next build must succeed
node scripts/remediation/verify-events-schema.mjs     # exit 0
node scripts/remediation/index-census.mjs > after.txt ; diff before.txt after.txt
```

**A clean `tsc` is necessary and nowhere near sufficient.** These classes compile perfectly:

**(a) THE FUNCTION-PROP CHECK — do this by hand, for every pair.** Mistake ③. For each new
route/component pair, open the `page.tsx` and confirm **every prop it passes is a string, a
number, a boolean, or a plain serialisable object.** No arrow functions, no `href` builders, no
callbacks.

| Route (server component) | Component | Props it may pass |
|---|---|---|
| `src/app/cca/[ccaID]/events/[eventID]/door/page.tsx` | `EventDoorScanner` | `eventID: number`, `backHref: string` |
| `src/app/admin/events/hall/[eventID]/door/page.tsx` | `EventDoorScanner` | `eventID: number`, `backHref: string` |
| `src/app/admin/events/insights/page.tsx` | `HallInsights` | *(none)* |

`EventQuestionBuilder`, `EventSignupQuestions` and `MyCheckInCode` are mounted from **client**
components, so the rule does not bind them — **but check anyway**, because it is one grep and
the last time this was assumed, five routes 500'd.

**(b) `editScope("submitted")` must still be `"none"`.** Unchanged by this plan; re-read
`schemas/event.ts:71-83` before touching that file, because D-44 sits next to it and "make
questions editable while submitted" is a one-word change that compiles and silently reinstates
the moving-target bug ruling C-2 removed.

**(c) A second copy of the ownership branch.** `loadOwnedEvent` (`R:102-123`) and
`assertMayScan` (D-61) are the only two places the `ccaID == null` branch may live, plus the
deliberate third copy in `/api/event/upload/route.ts:78-88`. Grep for `manageHallEvents` and
confirm the count.

**(d) `EVENT_QR_SECRET` in BOTH halves of `env.js`.** The `server` block *and* `runtimeEnv`.
Miss the second and it reads `undefined` forever, silently, with a passing build (D-56).

**(e) A client file importing `eventQr.ts`.** `grep -rn "eventQr" src/app/` must return
**nothing**. That module imports `~/env` and `node:crypto` at module scope; the repo already
documents what that does to a client bundle (`roles.ts:602,646`).

**(f) `csvField` handling `=`, `+`, `-`, `@`.** T-28/D-50a. A unit-free check: call it with
`"=1+1"` and confirm the output starts with `'`. Then call it with `'=a,b'` and confirm the
result is `"'=a,b"` — **apostrophe INSIDE the quotes**. Reversed ordering yields `'"=a,b"`, which
is both invalid CSV and still a formula. The file is **`src/app/events/_lib/format.ts:116`**;
`src/lib/format.ts` does not exist.

**(g) PART B ADDS NO `page.tsx`. This is a one-command check and it is the mistake-③ tripwire.**

```bash
git diff --name-only --diff-filter=A origin/main... -- 'src/app/**/page.tsx'   # must be EMPTY for PR 2
```

D-40a: the builder mounts inside `DetailsEditor`, which is already `"use client"`. **A new
`page.tsx` in Part B means someone gave the builder its own route**, which is a server component
by default, and passing it an `onSave` callback is exactly the crash that took out five routes.
If the command returns a file, stop and read D-40a.

**(h) `createEventInput` has no `.default()`.** D-45a.

```bash
grep -n '\.default(' src/lib/schemas/event.ts     # must return NOTHING
```

zod populates a defaulted field even when the caller omits it, so one `.default()` makes
`isBareCreate` (`R:531-533`) false for every bare create — reuse never fires again, silently,
with a green build. That is the exact bug `195b063` was written to fix.

**(i) The D-39a guard is present on the reuse branch.** Grep `src/server/api/routers/event.ts`
for `eventQuestion.count` and confirm it sits **inside** the `if (existing && existing.photoUrls
.length === 0)` block at `R:566`, **before** the `return { eventID: existing.eventID }`. A
`count` placed after the return is dead code that type-checks.

**(j) The `signup` P2002 catch still exists.** D-43a adds an early return; it does **not** replace
the catch. Confirm `R:1986-1997` is intact and that `validateAnswers` is called **after** the
already-signed-up return, not before it.

### 13.2 Two things that MUST be verified before the first real row lands

**Step 1 — the compound-unique index actually exists.** Not "Prisma says `@unique`". Read
`listIndexes` for both collections and match on the **key pattern**. §9.3. Then prove the
`P2002` path: insert two `EventAttendance` rows with the same `{eventID,userID}` from a script
and confirm the second is refused.

**Step 2 — an `EventSignup` row with NO `answers` key reads back as `[]`.** T-24, D-49, and it
is **BLOCKING**.

```
a. Insert, with the raw driver, an EventSignup document containing ONLY
   { eventID, userID, createdAt } — no `answers` key at all.
b. Read it through db.eventSignup.findMany().
c. It must come back with answers: []. If Prisma THROWS, stop.
```

**If it throws, the fallback is a separate `EventAnswer` collection** keyed
`[eventID, userID, questionID]`, written inside the same `withEventLock` block, with the purge
becoming a `deleteMany` and the count therefore living on `EventSignup` where it already is.
That fallback is named here so the coder does not invent one under pressure, and it costs the
embedded-list argument in D-49 without costing anything else in the plan.

> **⚠ THE "ZERO ROWS AT RISK" ARGUMENT NO LONGER HOLDS. RE-READ §0.1.**
>
> The original text said production had 0 `EventSignup` rows, so nothing legacy was at risk.
> **`eventID 1` is a real published event with a facility booking**, so `EventSignup` may hold
> real rows — and **every one of them has no `answers` key**, because the field does not exist in
> `prisma/schema.prisma` on this branch at all.
>
> The population at risk is therefore **unknown, not zero**, and could not be measured this pass
> (§0.0 — the cluster is unreachable from the NUS network; port 27017 is blocked outbound).
>
> **This makes step 2 strictly more blocking than it was, not less.** Run it from a network that
> can reach Atlas, before PR 2 deploys. If it throws, the fallback below is not a contingency —
> it is the design.
>
> **Do the check on a throwaway `eventID`, never on `eventID 1`.** That row and its signups are
> READ-ONLY for this entire plan: do not insert against it, do not update it, do not sweep it.

**If it throws, the fallback is a separate `EventAnswer` collection** — see the paragraph above;
it is named so the coder does not invent one under pressure.

### 13.3 What MUST be checked by a human, in a browser, after each deploy

Three accounts: a `cca_head` who is not `jcrc`, a `jcrc`, and a plain `resident` with a matric.
**Plus a phone** for §13.3 D — the door page cannot be tested on a laptop and mean anything.

---

**A — Part A: one screen, one action**

1. As the head, `/cca/{ccaID}/events` → **New event**.
   *Expect:* you land **directly** on the authoring screen, with a blank form. **There is no
   intermediate screen and no "Continue" button anywhere.** The URL is
   `/cca/{ccaID}/events/{eventID}`.
2. Confirm the one screen holds **all of**: name, description, start, end, location/facility,
   capacity, banner, photos, public description — and, after PR 2, the questions builder.
3. Confirm the footer has **exactly two** buttons: "Save and finish later" and "Submit for
   review", and that the sentence from §11.1 sits above them.
4. Press **Back** without typing anything. Press **New event** again.
   *Expect:* **the same eventID** (D-30). Not a second row.
5. Type a title, press **Save and finish later**, go back, press **New event**.
   *Expect:* a **new** eventID. The titled row was not reused.
6. `/admin/events` → **Hall events** → **New event**.
   *Expect:* the same, at `/admin/events/hall/{eventID}`, with **"Register and publish"** in
   place of "Submit for review".
7. Navigate directly to `/cca/{ccaID}/events/new`.
   *Expect:* **404**. The route is gone.
8. **The C-10 race.** Open the same draft in two tabs. In tab A press **Cancel event** and
   confirm. In tab B press **Submit for review**.
   *Expect:* tab B is refused with *"This event can’t be submitted from its current state…"*
   and the event is **still cancelled**. **A resurrected event here is a ship-blocker.**

---

**B — Part B: questions**

9. Add one of **each of the seven types**. Make two required. Reorder. Remove one. Save.
   *Expect:* saved; reload shows the same order; the removed one is gone.
10. Add a `single_choice` with **one** option.
    *Expect:* refused with *"A choice question needs at least two options"*, on that row.
11. Add two identical options.
    *Expect:* *"Two options can’t be the same"*, on the second one.
12. Submit for review. As the jcrc, open it.
    *Expect:* the questions render **read-only** above the decision buttons (D-47). Approve.
13. As the head, try to edit the questions while it is `submitted`.
    *Expect:* the builder is not on the page at all — the submitted panel replaces the editor.
14. As the resident, sign up.
    *Expect:* the Dialog opens. The retention line from §11.2 is visible **before** the first
    field. Leave a required one blank → *"Please answer this"*. Fill it in → signed up.
15. As the head, open **Attendees**.
    *Expect:* an answer column per question, with the resident's answers. Download the CSV and
    open it **in Excel or Sheets**: confirm a question labelled `=1+1` renders as text, not as
    `2` (T-28).
16. As the head, now try to add a question.
    *Expect:* the frozen panel from §11.2, naming the signup count. **Not** a form that fails on
    save.
17. **The freeze race.** Open the builder in tab A. In tab B, sign up as a resident. In tab A,
    press Save.
    *Expect:* *"Someone signed up while you were editing, so the questions are locked now."* —
    **not** the generic "Try again."
18. Sign up for an event with **zero** questions.
    *Expect:* **one tap**, no dialog. Unchanged Phase 1 behaviour.

18a. **THE D-39a REUSE CHECK — the single most important browser step in Part B.** No unit test
     reaches it: it needs a real abandoned row, real question rows, and a second button press.
     Part A's own reuse bug was found exactly this way and by nothing else.

     - As the head, press **New event**. Note the eventID. **Type nothing.**
     - Scroll to the questions builder and add **three** questions. Save.
     - Navigate away without ever entering a title.
     - Press **New event** again.

     *Expect:* **a NEW eventID, and an empty questions builder.**

     *If you get the SAME eventID with the three questions still in it, D-39a was not
     implemented and this is a ship-blocker.* The failure is silent — the screen looks like a
     normal new event — and its consequence is a head submitting a form they did not write this
     time, which the JCRC then approves and D-44 freezes on first signup.

18b. **The other half of D-39a — reuse must still work.** Press **New event**, type nothing, add
     **no** questions, navigate away, press **New event** again.

     *Expect:* **the SAME eventID.** If this now allocates a new id every time, the guard was
     written too broadly and Part A's blank-draft cap (D-30) is broken again — the same
     regression `195b063` fixed, in the opposite direction. Both 18a and 18b must pass; either
     one alone is not evidence.

18c. **D-43a idempotency.** As the resident, sign up (answering the questions). Then, from a
     stale tab or by re-firing the mutation, submit **`{ eventID }` with no answers**.

     *Expect:* `{ signedUp: true }` — success, and the **stored answers unchanged**. Not
     `ANSWERS_INVALID`. Then check the head's Attendees table shows the original answers, proving
     "first answer wins" (D-43a, D-48 point 2).

---

**C — Part B: retention**

19. In the DB, set an event's `endTime` to 61 days ago. Reload the head's Attendees table.
    *Expect:* the "Answers are no longer available" panel, and the counts still correct. The
    rows are **still in the database** — this is the read cutoff (D-52 layer 1) proving it works
    without the script.
20. Run `purge-event-answers.mjs` **without** `--commit`.
    *Expect:* it names that event, counts the rows, and writes nothing. Confirm
    `answersPurgedAt` is still null.
21. Run it with `--commit`. Confirm `answers: []` on the signups, `answersPurgedAt` stamped, and
    **the signup rows still present**. Confirm the head's signup count is unchanged.
22. Run `verify-events-schema.mjs`. Check [10] must pass.

---

**D — Part C: the door, ON A PHONE**

23. As the head, set the door window, nominate one CCA member as a scanner, open the door page
    on a **laptop** first.
    *Expect:* the manual list is visible **immediately**, before you press "Start camera".
24. On an **Android phone in Chrome**: press Start camera, scan a resident's code.
    *Expect:* their name, "On the list", the count increments.
25. On an **iPhone in Safari**: same. **This is the test that cannot be skipped** —
    `getUserMedia` needs a user gesture on iOS and a `useEffect` autostart fails only here.
26. **Open the door page from a link inside Telegram or Instagram** on the phone.
    *Expect:* the in-app-browser message from §11.3, naming the apps, **and the manual list
    below it**. **A black rectangle is a ship-blocker.**
27. Scan the **same** person twice.
    *Expect:* "Already checked in at {time}". The count does **not** increment. Then check the
    DB: **exactly one** `EventAttendance` row. Two rows means the index is missing (mistake ②).
28. Scan someone who **did not sign up**.
    *Expect:* checked in anyway, "Not on the list", `wasSignedUp: false` in the DB.
29. **The boundary.** Have a resident hold their code steady and scan it repeatedly for 90
    seconds across at least two rotations.
    *Expect:* every scan is accepted. A refusal at the boundary means `w-1` is not being checked.
30. **Expiry.** Screenshot a code, wait 90 seconds, scan the screenshot.
    *Expect:* refused with *"That code didn’t work…"*.
31. **T-36.** Check a resident in, then have them **cancel their signup**, then reload the head's
    turnout.
    *Expect:* they are still counted as **turned up**, not as a walk-in. A flip here means
    `wasSignedUp` is being re-derived instead of read.
32. **Undo.** Undo a check-in. Confirm the count drops, the row is gone, and
    `RoleAuditLog` holds an `event.checkin.undo` row with `targetUserID` set to that resident.
33. **T-32.** Remove the nominated scanner from the CCA (`cca.removeMembers`). Have them try to
    scan.
    *Expect:* *"You’re not set as a scanner for this event any more."* **If they can still scan,
    the live membership check is wrong** — and check the mixed-key case specifically: a member
    whose only `UserCCA` row is legacy A-format must be recognised as a member *before* removal.
34. **Window.** Set `attendanceClosesAt` to a minute ago. Scan.
    *Expect:* *"Check-in closed at {time}."*
35. **Flag.** `set-attendance-flag.mjs off --commit`, wait 15 s, reload the door page.
    *Expect:* inert, with the right message. The head's signup charts still work.
36. **The index gate.** On a scratch database with no `event_attendee` index, run
    `set-attendance-flag.mjs on --commit`.
    *Expect:* **refused**, naming the missing index (§9.4).

---

**E — Part D: dashboards**

37. Head's event page during the door window: the live count updates without a reload.
38. After: the split, and the no-show list with its caveat sentence.
39. An event with **no** attendance data at all: turnout renders **`—`**, never `0%` (D-76).
40. `/admin/events/insights` as the jcrc: every event in range, a "Hall" row for hall events
    (**not** `CCA #null`, and **not** blank — T-4), and the informational-only sentence.
41. As a `cca_head` who is not jcrc, request `/admin/events/insights` directly.
    *Expect:* redirected. The layout gate (`layout.tsx:39`) is the guard.
42. As an `scrc` holder: `/scrc` events tab. Confirm **no** questions, **no** answers, **no**
    attendance, **no** scanner list, and no new control anywhere.

---

**F — authorisation, which a green build says nothing about**

43. As head A, call `event.saveQuestions` on head B's event directly.
    *Expect:* `NOT_A_HEAD_OF_THIS_CCA`.
44. As a resident who is not a scanner, call `event.checkIn` directly.
    *Expect:* `NOT_A_SCANNER`.
45. As a nominated scanner, call `event.getSignupAnswers`.
    *Expect:* refused — scanners scan; they do not read answers.
46. As an `scrc` holder, call `event.getDoorRoster` and `event.saveQuestions` directly.
    *Expect:* both refused.
47. Call `event.myCheckInToken` for an event you have not signed up for, **outside** the door
    window. *Expect:* refused.
48. Craft a QR payload for **someone else's** userID with a made-up token.
    *Expect:* `BAD_QR`, and **no information about whether that userID exists** (D-57).

---

## 14. Traps in this change

Numbering continues from plan 01, whose **T-1 … T-18 all still apply**. Ordered by how expensive
the mistake is, not by how likely.

### T-19 — a server component passing a function prop still 500s every route

Plan 01 shipped this and it killed all five authoring routes while `tsc`, ESLint, `next build`
and two review agents passed. The surviving warnings are at `EventCreateForm.tsx:33-38` (about to
be deleted with that file — **move the comment to `EventManage.tsx`, do not lose it**) and
`EventManage.tsx:821-823`.

Three new route/component pairs in this plan. §13.1(a) checks each by name. **Pass a base path
string; build the URL client-side.** The one that will be tempting is the door page's
`onCheckedIn` callback — it is a *client* → *client* prop and is therefore legal, but the moment
someone lifts `EventDoorScanner` into a server page it is not.

### T-20 — `npm run db:generate` runs `prisma migrate dev`

`package.json:8`. Read mistake ① and D-80. **The obvious npm script is the forbidden command.**

### T-21 — a Prisma `@unique` on Mongo creates nothing, and the failure is silent

`create-auth-allowlist.mjs:29-33`. Without `createIndexes`:

- two `EventQuestion` rows can share a `questionID`, and every answer to either is ambiguous;
- a re-scan writes a second `EventAttendance` row, and the turnout number is wrong.

**Neither raises an error anywhere.** `tsc` passes, the build passes, the feature demos
correctly, and the numbers are quietly wrong for a term. §9, and the flag gate in §9.4.

### T-22 — creating the draft in a `useEffect` double-creates in dev and again on Back

React 18 StrictMode double-invokes effects in development (`react ^18.3.1`). A mount-time
`create.mutate` makes two events every time a developer opens the page, behaves correctly in
production, and ships. The browser Back button then makes a third in production too. **The
button is the mutation** (D-29).

### T-23 — the answers write must not be a SECOND write, and must not sit after the P2002 catch

`R:1982-1997`. The `create` swallows `P2002` and returns `{ signedUp: true }` **without
writing**. An answers write placed after that block is skipped on every retried submission,
while the caller is told it worked. And a write placed after the `withEventLock` callback is
outside the mutex the capacity check needs.

**One write. `answers: v.normalized` on the existing `eventSignup.create`.** Read mistake ④.

**The related, correct-but-surprising behaviour:** a caller who is already signed up gets
success and their **stored answers are left alone** (D-43). First answer wins. That is right —
a capacity-full retry must not be able to rewrite an answer — and the copy in §11.2 must not
promise otherwise.

### T-24 — a composite list on rows written before the field existed

`EventSignup` rows created before PR 2 carry **no `answers` key**. Prisma returns `[]` for an
absent *scalar* list; for an absent **composite** list this repo has no precedent — all ten
`type` blocks in `schema.prisma:11-76` are legacy introspection, none is hand-authored, and none
has a zod schema mirroring it.

If Prisma throws instead, invariant I-2's stated failure mode fires: *"a row written by a script
or a partial hand-fix that omitted a required scalar would break Prisma deserialization for
every subsequent reader"* (`schema.prisma:700`) — and it would break `getPublic`,
`listMySignups` and every signup read at once.

**§13.2 step 2 is BLOCKING and the fallback is named there** (a separate `EventAnswer`
collection), so nobody has to invent one at 2 a.m.

### T-25 — `EXT:` ids contain a colon, so `:` cannot delimit a signed payload or a QR

`identity.ts:127`. `canonicalUserID` cannot emit `:` (`:108`) — that is the whole basis of the
two namespaces being *provably* disjoint — but `EXT:HALLOFFICE` is a real, admin-pinned key that
does. `"event-checkin:" + userID + ":" + w` is ambiguous for it, and an ambiguous HMAC payload
is a forgery primitive.

**`|` in both the payload and the wire format**, as `admin.ts:352-365` already does. Read
mistake ⑤ and §8.

### T-26 — `timingSafeEqual` THROWS on a length mismatch

`admin.ts:367-373` already handles it: `Buffer.from(…, "utf8")`, **length check first**, then
`timingSafeEqual`. A bare `===` on an HMAC leaks length, which that file's own comment calls "a
bad habit"; a bare `timingSafeEqual` on attacker-supplied input **throws**, which turns a
comparison into a 500 and an availability bug on a door.

Reuse `tokenMatches`. Do not write a second copy.

### T-27 — the QR carries the resident's canonical userID in cleartext

D-57. The server cannot reverse an HMAC, so it must be told whose token to recompute. A
bystander who photographs a screen gets a canonical id — an `@u.nus.edu` address one derivation
later — plus a token that is dead in ≤60 s.

**Accepted, not solved**, on the grounds that the same id is already visible to every head
through `exportAttendees`'s `resolveAttendees` projection (`R:194-252`) and `EventAttendees.tsx:106`. What must **not**
happen is the door becoming an oracle: `checkIn` returns the identical `BAD_QR` for an
unparseable payload, a bad signature and an expired window, and returns nothing at all about a
userID whose token did not verify.

### T-28 — a question label goes into a CSV header, and Excel executes formulas

`csvField` (**`src/app/events/_lib/format.ts:116-121`** — there is no `src/lib/format.ts`) quotes
on `/[",\r\n]/`. It does **not** neutralise a leading `=`, `+`, `-` or `@`, which Excel and
Google Sheets evaluate — `=HYPERLINK(...)` and `=cmd|'...'!A1` are the classic payloads.

Until now every CSV cell came from a controlled vocabulary or a person's own name. A **question
label** and a **free-text answer** are both authored by someone else and land in a file a head
opens on their laptop.

Prefix a `'` when a field starts with one of those four, **before** the quoting test — see
**D-50a** for the exact patch and why the order matters. Fix it in `csvField`, not in
`EventAttendees.tsx`, which would be a drift pair.

> **CORRECTION.** An earlier draft of this trap said the CCA roster export "gets the fix for
> free". **It does not.** `serializeCsv` has exactly one caller (`EventAttendees.tsx:43`); the
> roster is a different format entirely — `RosterPanel.tsx:139` → `downloadXlsx`
> (`src/lib/xlsx.ts:213`). It also **needs** no fix: `sheetXml` (`src/lib/xlsx.ts:64-77`) writes
> every cell as `t="inlineStr"`, which Excel never evaluates as a formula. Blast radius of this
> trap is **one function, one export**. D-50a.

### T-29 — a purged event must export `—`, not blank

An empty answer cell after a purge is indistinguishable from "this person did not answer". The
head reads the file, concludes their members ignored the form, and is wrong. §11.2's literal.

### T-30 — every new `Event` column is an SCRC disclosure decision

`getForOversight` returns `{ ...event }` unredacted to a manager and
`{ ...event, ...SCRC_HIDDEN_EVENT_FIELDS }` otherwise (`R:1842-1855`). The `satisfies
Partial<Record<keyof Event, …>>` clause at `:406` catches a **typo**, never an **omission**.

**This plan adds no `Event` column, so nothing is exposed** (D-69, §7.3) — which is exactly the
condition that makes it easy for the next phase to forget. T-18 generalised: **when a field is
added to a model, classify it against every projection that model already has.**

### T-31 — epoch seconds and `DateTime` sit side by side on `model Event`

`attendanceOpensAt` and `attendanceClosesAt` are **`Int?` epoch SECONDS**
(`schema.prisma:804-806`); `answersPurgedAt`, `decidedAt`, `publishedAt`, `createdAt` are
**`DateTime?`**. `EventAttendance.checkedInAt` is a `DateTime?` and the door window it is
compared against is in seconds.

Comparing one to the other is a **1000×** error that typechecks in JS the moment either side
goes through `Number()`. `EventsOversightPanel.tsx:152-154` and `:171-173` already carry warning
comments about this exact pair. Every new comparison converts explicitly, in one direction,
named at the call site.

### T-32 — `UserCCA.userID` is mixed-format, so a single-key membership lookup lies

`ccaMembers.ts:37-44`, verbatim: *"UserCCA.userID is mixed-format: a person can hold a legacy
A-format row AND a canonical row for the same CCA. Deleting only the canonical one 'removes'
them while their legacy row keeps them on the roster."*

The read side has the mirror bug. `isLiveCcaMember` (D-61) checking only the canonical key
reports "not a member" for anyone whose only row is legacy — and the user-visible failure is a
committee member standing at a door being told they are not in their own CCA. **Use
`membershipKeysFor`**, which exists for precisely this and is already the single definition.

### T-33 — the manual list must not be a fallback behind a camera error

If the roster only appears after `getUserMedia` fails, then on a phone where the camera *half*
works — permission granted, stream black, decode never fires — the committee gets neither. The
list is **always rendered**, and every camera-error branch mentions it (§11.3).

This is also what makes the connectivity story honest: the door page is online-only, and the
manual list is what a committee uses when the camera is the thing that is broken, not when the
network is.

### T-34 — `EventAnalytics` is mounted only inside the `published` branch

`EventManage.tsx:992-1000`. An attendance panel added there is **invisible for a `canceled`
event that already happened** — which is exactly the event whose turnout somebody wants to look
up afterwards, because it was cancelled *after* it ran.

Either accept it and say so, or mount the analytics section for `published` **and** `canceled`.
**This plan accepts it**, because a cancelled event coming off the timeline is the point, and
the hall-wide page (D-74) still shows it. Recorded so it is a decision and not an accident.

### T-35 — the freeze makes a head's open builder silently unsaveable

A head opens the builder on a published event with zero signups; a resident signs up; the head
presses Save. The server refuses `QUESTIONS_FROZEN` forever after. **Retrying can never
succeed**, so the generic "That didn't save. Try again." would send them into a loop — the same
defect plan 01 §8.10 had to fix twice, for `NOT_CANCELABLE` and then again for
`NOT_SUBMITTABLE`. §11.2 gives it its own string.

### T-36 — `wasSignedUp` is a SNAPSHOT and must never be re-derived

`cancelSignup` (`R:2000-2010`) is a hard delete with **no time gate** — a resident can
cancel at any moment, including after they were scanned in. A turnout view that joins
`EventAttendance` back to `EventSignup` at read time would silently reclassify them as a
walk-in, and the CCA's turnout number would change days after the event.

**Store it at scan time (D-59, D-60 step 8) and read the stored value everywhere** — including
in `getAttendanceStats`'s `walkIns` / `turnedUp` counts (D-72) and the hall-wide roll-up.

### T-37 — a retention promise worded against a script nobody runs

D-52. There is no cron in this repo — no `vercel.json`, no cron key in `package.json`. The
resident-facing sentence must be true of what the **application** guarantees, which is the read
cutoff, not of what an operator remembers to do.

**The failure mode to avoid is not "the script doesn't run".** It is "the copy said deleted, the
script never ran, and somebody found the answers in the database eighteen months later." §11.2's
wording is the mitigation and it must not be "improved" into a deletion promise.

### T-38 — sharing `withEventLock` means a question save can wait behind a signup burst

`withEventLock` retries 50 × 100 ms and then throws *"This event is busy right now — please try
again."* (`services/events.ts:143-148`). D-45 puts question saves through the same mutex as
signups, deliberately, because that is what makes the freeze check atomic.

The cost is a head saving a form during a signup rush waiting up to 5 s, or seeing that message.
**Acceptable** — a head editing a form is not on a hot path, and the alternative (a second lock)
means two mutexes that must be taken in a consistent order, which is a deadlock waiting for a
maintainer. Recorded so the wait is understood as a trade and not a bug report.

### T-39 — `event.update` gaining a `"public"`-scope field is the one scope widening here

D-65 lets `attendanceOpensAt` / `attendanceClosesAt` / `scannerUserIDs` be written while
`published`, which means adding them to the `scope === "all"` **and** the shared block in
`update` (`event.ts:552-556`). Everything else in the `"public"` branch is content residents
see.

**Do not widen it further "for symmetry".** The reason these three are in it is that they are
the only fields a head needs to fix *on the day*; `capacity`, `startTime` and `location` are
deliberately fixed once an event is live and the copy at `EventManage.tsx:1023-1027` says so.

### T-40 — `getPublic` returning questions must not leak them for an unpublished event

`getPublic` already refuses anything that is not `published` or `canceled`
(`R:1899-1905`) and that guard runs **before** the projection. Keep the questions read
**after** it. Fetching questions first and then checking status would disclose a draft event's
form to any authenticated resident who guessed an eventID.

Same rule for `canceled`: `getPublic` returns cancelled events (someone still has the link), and
they may carry questions. Returning them is harmless — signup is closed — but the client must
not render a form under "Signups are closed." (`EventDetail.tsx:145-146`).

---

## 15. What a later phase inherits

Recorded so nothing here is mistaken for an oversight.

**Left deliberately undone by this plan:**

- **No notifications, still.** A head learns their event was declined, a resident learns a form
  changed, and a committee learns the door opened — all by opening a page. Plan 01 §13 said this
  and it is still true.
- **No JCRC answers view** (D-48). The access ceiling permits it; nothing builds it. If it is
  wanted: one procedure on `roleManagerProcedure`, a live `reviewEvents` re-check, and **an
  audit row**, in the class of `event.attendees.export`.
- **No editing your own answers** (D-48). Cancel and re-sign-up is the path.
- **No file-upload answers** (D-48).
- **A hall event's scanners must hold `manageHallEvents`** (D-61). The JCRC cannot deputise a
  non-JCRC volunteer for a hall event. The right fix is a per-event, expiring nomination that
  carries its own revocation — **not** widening `assertMayScan`'s membership check, which would
  make "nominated" mean "trusted forever".
- **No term model** (D-75). The hall-wide page takes a date range.
- **No offline door.** The page is online-only with a pre-loaded roster (D-63); if the wifi dies
  the committee ticks people off the list, and those rows say `method: "manual"`. A genuinely
  offline queue means a client-side write log and a merge, which is a different feature.
- **Turnout is never a consequence** (D-77). Anything that reads `EventAttendance` to decide
  something about a person needs its own ruling.

**Inherited from plan 01 and still true:**

- The audit log UI renders neither `targetCcaID` nor `targetEventID`
  (`AuditLogTable.tsx:81-82`), so every event row shows `—`. **Now slightly more annoying**,
  because `event.checkin.undo` carries a `targetUserID` that *would* render if the Target column
  looked at more than two fields. Still a self-contained task.
- `event.ts` still duplicates `findFacilityConflict` inline in `decide`'s auto-book block.
- `deleteCcaCascade` still does not clean up `Event` rows (T-2) — **and now does not clean up
  `EventQuestion` or `EventAttendance` either.** It has no UI caller (`cascade.ts:28-31`: "NO UI
  REACHES THIS"), so the exposure stays script-only. Recorded; **do not fix it here.**
- `getForReview` is not narrowed to `submitted`, deliberately (T-10).

**New in this plan, and worth knowing:**

- `EventQuestion` and `EventAttendance` rows survive their event being cancelled, declined, or
  swept — except by `sweep-blank-event-drafts.mjs`, which refuses any event that has either
  (D-33 conditions 6–7).
- Blob orphans are still unreaped. `list()` is called nowhere in this repo. Part A does not make
  it worse (D-31), and a reconciler remains an unbuilt, one-afternoon script.

---

## Appendix A — the `prisma db push` position, restated for this plan

> **DO NOT RUN `prisma db push`. DO NOT RUN `prisma migrate`. DO NOT RUN `npm run db:generate`.**

Plan 01's Appendix A said the first two. This plan adds the third (C-11, D-80) because the npm
script is the shortest path to the first two and it is named after the safe command.

**The whole database procedure for every PR in this plan:**

```bash
npx prisma generate                                          # types only, never the cluster
node scripts/remediation/create-event-phase2-indexes.mjs     # dry run
node scripts/remediation/create-event-phase2-indexes.mjs --commit
node scripts/remediation/index-census.mjs > census-after.txt ; diff census-before.txt census-after.txt
```

**Why `generate` alone is enough for everything except the two indexes.** On MongoDB, Prisma's
schema is a client-side type assertion. Adding a `type` block, adding a field, adding a
collection: none is DDL. Mongo creates a collection on first write. The **only** server-side
artefact that does not appear by itself is an **index** — which is the entire subject of §9.

**Why a push is dangerous here specifically.** It cannot represent a collation index, so it
classifies `User.email_unique_ci` as "not in schema" and drops it, silently, without needing
`--accept-data-loss`. That index is the only thing preventing two rows differing solely in
letter case from becoming two accounts for one human — the duplicate-account class this repo has
hand-remediated four times. It has been dropped and restored on this cluster before.

**If it is dropped:** §9.6's one-liner. It will fail with `E11000` if duplicates formed in the
window it was absent — **that failure is the detector, not a problem with the command** — and
`merge-by-canonical.mjs` is the remedy.

---

## Appendix B — the expected index census delta, in full

| Stage | Collection | Index | Key | Unique | Expected |
|---|---|---|---|---|---|
| before all | `EventQuestion` | — | — | — | **(absent)** |
| before all | `EventAttendance` | — | — | — | **(absent)** |
| after PR 2 | `EventQuestion` | `_id_` | `{_id:1}` | no | new |
| after PR 2 | `EventQuestion` | `event_question` | `{eventID:1,questionID:1}` | **yes** | new |
| after PR 3 | `EventAttendance` | `_id_` | `{_id:1}` | no | new |
| after PR 3 | `EventAttendance` | `event_attendee` | `{eventID:1,userID:1}` | **yes** | new |
| every stage | `User` | `email_unique_ci` | `{email:1}` + collation `en`/2 | **yes** | **unchanged — the red line** |
| every stage | `Event`, `EventSignup`, `EventLock`, `Counter`, `Bookings`, `BookingLock` | — | — | — | **unchanged** |

**Four added lines across two PRs. Zero removed lines, ever.** Any removed line stops the
rollout until it is restored (§9.6).
