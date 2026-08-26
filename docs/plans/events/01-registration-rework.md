# Events registration rework — Phase 0 + Phase 1

**Ask:** the Events feature is merged, live, and unused. Replace the *proposal* front
door with a *finished event* front door, split rejection into "fix this" and "no", let
the JCRC own hall-wide events, and make approval publish.

**Scope:** Phase 0 (schema + shared vocabulary + rollout) and Phase 1 (router + UI + copy).
Nothing below builds the question-form builder, the QR door scanner, dashboards,
notifications, or the 60-day purge. Four fields land inert in Phase 0 so those phases
never need a second schema pass (D-17).

**Status:** proposal. Nothing below is implemented. Branch `events-registration-rework`,
based on `main` @ `1bc5e0f`.

**Convention note:** this repo's plans live at `docs/plans/<area>/NN-topic.md`
(`docs/plans/rbac/01-data-model.md`, `docs/plans/cca/01-group-interview-slots.md`); there
is no `PLAN-*.md` at the repo root and never has been. This file sits at
`docs/plans/events/01-registration-rework.md` accordingly, and its *structure* follows
`docs/plans/rbac/01-data-model.md`.

**Adjudication status:** every contradiction raised in §0.9 has been ruled on by the
human. The rulings are folded into the body below and each C-item records its outcome.
Where this document and the original brief differ, **this document wins**.

---

## READ THIS FIRST — the three mistakes that will actually ship

Everything else in this document is a detail. These three are the ones that compile
cleanly, pass review, and are wrong in production. They are repeated in full in §12 with
their reasoning; they are here because §12 is 1,900 lines away and these must be read
before the first line of code is written.

### ① A hall event's booking uses `ccaID: 0` — never `null`, never `!`

`src/server/api/routers/event.ts:901`, inside `decide`'s auto-book block:

```ts
ccaID: event.ccaID ?? 0,   // 0 = the reserved "no CCA" sentinel — cascade.ts:47
```

`Event.ccaID` becomes nullable; `Bookings.ccaID` does **not** and must not.
`BookingsCreateInput.ccaID` is `number`, so the old line stops compiling — and two of the
three obvious fixes are wrong:

| Fix | What happens |
|---|---|
| `event.ccaID!` | Compiles, writes `null` into a required Int. Blows up later, in someone else's query. |
| `event.ccaID ?? null` | Doesn't compile — and the tempting next move, making `Bookings.ccaID` nullable, is the real catastrophe: a second value meaning "absent" in a 17,456-row collection where `0` already means it, guarded by `cascade.ts:47` and written by `BookingModal.tsx:115`. |
| **`event.ccaID ?? 0`** | **Correct.** |

**If the diff touches `model Bookings`, the change is wrong.** Full reasoning: D-8, T-1.

### ② Two "Hall" display sites fail by rendering *nothing*

```tsx
EventsTimeline.tsx:189    {e.ccaName && (<span …>{e.ccaName}</span>)}
EventDetail.tsx:113       {e.ccaName && (<p …>{e.ccaName}</p>)}
```

A hall event has `ccaName === null`, so the owner line silently vanishes from the two
highest-traffic resident pages. No error, no warning, no `tsc` complaint — the element is
simply absent from the DOM, and a casual browse will not catch it. The four
`` `CCA #${ccaID}` `` sites at least render visible garbage. Fix all six to call
`ownerLabel(ccaID, ccaName)` (§5.10). Full census: §7, and it is tested by name in §11.2
step 9. Full reasoning: T-4.

### ③ Write `ccaID: null` explicitly — never omit the key

`create` and `duplicate` must both pass `ccaID: null` in the `data` object for a hall
event. Omitting it writes a document with **no `ccaID` key at all**, and this repo has a
standing rule about exactly that (`docs/plans/cca/01-group-interview-slots.md` §0.4):
`{ field: null }` matches a **stored** null but **NOT an absent field**.

`listForOwner`'s hall branch queries `where: { ccaID: null }`. A row written without the
key is **invisible to the only list that can reach it** — created successfully, then
unmanageable, with no error anywhere. It still reads back fine via `findUnique({ eventID })`,
so every test that fetches one event by id passes. Full reasoning: T-12.

---

## 0. Ground truth, verified against the repo and against production

Every number in this section was measured on 2026-08-26 against the live `DATABASE_URL`,
not read from a document.

### 0.1 The collection is empty. The destructive change is free.

```
Event                0 rows
EventSignup          0 rows
EventLock            0 rows
RoleAuditLog where action startsWith "event."   0 rows
```

`events.enabled` = `"on"`, written `2026-07-25T07:57:04Z` by `script:set-events-flag`.
`scrc.enabled` = `"on"` since `2026-08-09`.

So the feature has been switched on in production for a month and **has never been used
once**. There is no data to migrate, no status string to backfill, no audit row whose
action name must survive, and no blob to re-parent. Dropping a column, renaming a status,
and retiring an audit action are all free — and only in this window. Re-measure before
starting (§9.1); if any of those four counts is non-zero, **stop** and re-plan, because
three of the decisions below (D-1, D-4, D-5) assume the zero.

### 0.2 The front door asks for work already finished

`src/app/cca/_components/EventCreateForm.tsx:83-86` is the first thing a CCA head reads:

> "Save the draft first — then you can attach the proposal PDF and submit it for review."

and `EventFileField.tsx:61-64`:

> "Event proposal (PDF)" / "The document JCRC reviews. Residents never see this."

`submitForReview` (`src/server/api/routers/event.ts:437`) makes that PDF **mandatory**:

```ts
if (!event.proposalUrl) missing.push("proposalUrl");
```

Per the JCRC (WhatsApp, 16 Aug 2026) proposals are settled by email with RFS and the Hall
Office and will not move into the app. So the app's first screen asks a head to re-do
finished work, and the required field cannot be satisfied by anything they have. That is
the whole reason for the zero in §0.1.

### 0.3 The two-phase field split

`src/lib/schemas/event.ts:40-42`:

```ts
export const PROPOSAL_EDITABLE: readonly EventStatus[] = ["draft", "rejected"];
export const PUBLIC_EDITABLE: readonly EventStatus[] = ["approved", "published"];
```

Enforced server-side only, at `event.ts:347` (`updateDraft`), `:425` (`submitForReview`)
and `:473` (`updatePublicContent`). **No UI file imports either constant** — the client
re-derives the same branching by hand at `EventManage.tsx:514` (`draft || rejected`),
`:532` (`approved`), `:547` (`published`). That duplication is a live drift pair and
collapsing the split (D-2) removes it.

### 0.4 `ccaID` is required and is spent as an authorisation key

`prisma/schema.prisma:721` — `ccaID Int` (required). It is read as an authorisation input
in two places, both of which take `number`:

- `event.ts:90` — `loadHeadedEvent` → `assertHeadsCca(db, { userID, roles }, event.ccaID)`
- `src/app/api/event/upload/route.ts:57-71` — loads the event, then `assertHeadsCca(..., event.ccaID)`

`assertHeadsCca` (`src/server/api/services/ccaScope.ts:53-76`) is typed `ccaID: number`
and reads `CcaHead` directly. There is no "no CCA" branch. Making `ccaID` nullable
therefore *has* to add one, and it will be a `tsc` error until it does — which is the
good failure mode.

### 0.5 `Bookings.ccaID` is required and `0` is the reserved "no CCA" value

Measured:

```
Bookings                     17,456 rows
Bookings where ccaID = 0      3,839 rows   (22.0%)
```

`prisma/schema.prisma:105` — `ccaID Int` (required, no default). The generated client
confirms it: `BookingsCreateInput.ccaID: number`, not `number | null`.

`src/app/_components/BookingModal.tsx:115` hardcodes `ccaID: 0` on every booking the
resident UI creates. `src/server/api/services/cascade.ts:47`:

```ts
export async function deleteCcaCascade(db: PrismaClient, ccaID: number) {
  if (ccaID === 0) throw new Error("RESERVED_CCAID");
```

…guarding `tx.bookings.deleteMany({ where: { ccaID } })` at `cascade.ts:51`, because a CCA
row that happened to hold `ccaID 0` would otherwise delete all 17,456 bookings. `0` is
therefore already the established, guarded, 3,839-row-strong sentinel for "this booking
belongs to no CCA". **See D-8 and Trap T-1.**

### 0.6 Every unique index Phase 1 depends on already exists

Measured with `listIndexes`:

| Collection | Index | Unique | Note |
|---|---|---|---|
| `Event` | `eventID` | ✅ | `nextEventId` idempotency |
| `Event` | `cca_status`, `status_start`, `start` | — | query indexes, unchanged |
| `EventSignup` | `event_user` (`eventID`,`userID`) | ✅ | the double-submit backstop at `event.ts:1278` |
| `EventLock` | `EventLock_key_key` | ✅ | **this is what makes `withEventLock` a lock** |
| `Counter` | `Counter_key_key` | ✅ | `nextEventId` / `nextBookingId` |
| `Bookings` | `Bookings_bookingID_key` | ✅ | `nextBookingId` |
| `BookingLock` | `BookingLock_key_key` | ✅ | `withFacilityLock` |
| `User` | `email_unique_ci` (`email`, unique, collation `en`/strength 2) | ✅ | **alive** |

Phase 1 adds **no new index**. See D-16 — this changes the rollout materially.

### 0.7 Existing validators

`Event`, `EventSignup`, `EventLock`, `Bookings`, `RoleAuditLog`, `SystemFlag` carry **no**
`$jsonSchema` validator. `User`, `CCA`, `UserCCA` and `Profiles` **do** — `schema.prisma:120`
marks `CCA` explicitly. Nothing in this plan adds a field to a validator-guarded model.

### 0.8 The four traps this codebase has already paid for

Named here because each recurs below:

1. **Sentinel-as-value** — an absent identity spent as a real one (`.claude` memory,
   `verify-identity-parity.mjs`). D-8 is a direct instance.
2. **`db push` drops non-schema indexes** — `email_unique_ci` has been dropped and
   restored once. `schema.prisma:469-470` and `index-census.mjs:26-29` both say so.
3. **Copy drifting out of sync with behaviour** — four incidents. §8 exists for this.
4. **Client re-deriving a server rule by hand** — §0.3.

---

## 0.9 CONTRADICTIONS — RAISED, AND ADJUDICATED

Four items where the brief and the code disagreed. **All four have been ruled on by the
human.** Each records the finding, the ruling, and where the ruling is implemented. None
was silently worked around, and none is still open.

Two further items the brief did not cover were also ruled on: the hall event's own review
loop (was T-11, now **D-27**) and this plan's file location (**A-1**, applied — the file
now sits at `docs/plans/events/01-registration-rework.md`).

### C-1 — `prisma db push` is not required, and running it is a net risk — **ACCEPTED**

> **RULING: accepted. No `prisma db push` in Phase 1.** The procedure is `prisma generate`
> only. The index census is retained as a before/after **verification** step, and
> `verify-events-schema.mjs` is a **read-only assertion** script — it asserts the required
> unique indexes exist and exits non-zero if any is missing; it never creates or drops
> anything. The guarded push procedure is kept in **Appendix A**, marked *not to be run in
> Phase 1*. Implemented in §9, §10, Appendix A.

The brief's D-16 mandated an index census around a `db push`. The census is right and is
kept (§9). **The push itself is not needed and must not be run.**

Phase 1 does three schema-file things: drop a field (`proposalUrl`), relax a field
(`ccaID Int` → `Int?`), and add four fields with defaults or nullability. On MongoDB,
Prisma's schema is a client-side type assertion — none of those is DDL. The only
server-side artefact `db push` produces is an **index**, and §0.6 measured that every
index this change depends on already exists and that Phase 1 adds none.

The repo already states this exact rule, at `prisma/schema.prisma:664-668`:

> "these two fields need no `db push` — which matters, because a push silently drops the
> non-schema indexes this database relies on (`email_unique_ci`). `prisma generate` is
> enough for this change."

and `index-census.mjs:31-33` goes further: *"the phase-2 rule is: NEVER run `prisma db
push` or `prisma migrate` on this cluster."*

So a push here buys nothing and puts `email_unique_ci` — the only thing preventing the
duplicate-account class this repo has hand-remediated four times — at risk. §9 specs
`prisma generate` only, with the census run before and after as evidence.

### C-2 — editing a `submitted` event lets the reviewer decide a moving target — **RESOLVED**

> **RULING: the moving-target problem is real. Lock on submit.** Editable states are
> **`draft` and `changes_requested` ONLY**; `submitted` is locked. An explicit
> **`withdraw`** transition (`submitted → draft`) is added — head-only, audit-logged —
> which also removes the event from the JCRC queue. A head fixing a typo withdraws, edits,
> resubmits. Implemented in **D-26**, §2.1 T3a, §4, §5.3, §5.7, §8.12, §11.2 C.

The brief's D-2 made everything editable in `draft`, `submitted` **and**
`changes_requested`. `submitted` is the state in which the JCRC is reading the record, and
today `PROPOSAL_EDITABLE` deliberately excludes it (`schemas/event.ts:40`).

The failure the ruling avoids: `decide` guards
`normalizeStatus(event.status) !== "submitted"`, so a *decision* could never land on an
event that had moved state — but it could land on one whose text changed five seconds
earlier, with the reviewer approving words they never read. `withdraw` replaces that
silent mutation with a visible state change: the event leaves the queue, the reviewer sees
it go, and it comes back as a fresh submission.

**Consequence carried through the whole document:** no copy anywhere may suggest a
submitted event is editable. §8.6's submitted panel is rewritten accordingly, and T-10 —
which used to describe the moving-target mitigation — is replaced by the withdraw-race
trap, which is the new sharp edge (§12 T-10).

### C-3 — "every mutation writes an audit row" is not what the code does — **ACCEPTED**

> **RULING: accepted. The brief's version of the rule was wrong.** The rule, stated
> normatively for this feature and applied consistently throughout:
>
> > **State-machine transitions are audited. Field saves are not.**
>
> **Audited:** `submitForReview`, `withdraw`, `decide` (all three outcomes), `cancelEvent`,
> `reviewerCancel`, `duplicate`, `exportAttendees`.
> **Not audited:** `create`, `update`.
> Implemented in §5.6 and D-22.

In the current router only `publish` (`:558`), `cancelEvent` (`:613`), `exportAttendees`
(`:777`) and `decide` (`:946`) audit. `createDraft`, `updateDraft`, `updatePublicContent`
and `submitForReview` write **no** audit row.

The rule above is the one the code already follows, and the one `ccaApplications` follows
(`ccaApplication.submit` / `.accept` / `.reject` are audited; field saves are not). The
rework adds the transitions that were missing (`event.submit`, `event.withdraw`) rather
than auditing every keystroke.

**Why saves are not audited.** `update` fires on every save and every autosave. A row per
save would bury the six rows that describe what actually happened to an event under
hundreds that describe someone typing — in a table whose stated purpose is "who was handed
a privilege, by whom, when", and which `admin.listAuditLog` pages 25 rows at a time.

### C-4 — the audit log UI renders no CCA and no event at all — **ACCEPTED**

The brief's D-10 listed "audit log rendering" as a "Hall" display site. It is not one.
`src/app/admin/_components/audit/AuditLogTable.tsx:81-82` renders the Target column as:

```tsx
{r.targetUserID ??
  (r.targetFacilityID != null ? `facility ${r.targetFacilityID}` : "—")}
```

`targetCcaID` and `targetEventID` are stored (`admin.ts:445-446`) but **never rendered**,
so every event audit row already shows `—`. A null `ccaID` changes nothing there. That is
a pre-existing gap, not a regression.

> **RULING: accepted. Dropped from the "Hall" display census.** §7 covers only sites
> confirmed by grep — including the two silent-blank ones. Fixing the audit table's Target
> column is **out of scope** for this run. Recorded in §7.4 (sites that are NOT Hall sites)
> so nobody hunts for a site that does not exist, and in §13 as something Phase 2
> inherits.

---

## 1. Decisions

Each numbered decision states the change and the reason. D-1…D-18 map to the brief's
locked list; D-19…D-25 are decisions the brief left open that the coder cannot proceed
without.

### D-1 — Proposals are ripped out entirely

Delete `Event.proposalUrl`, the `"proposal"` member of `EVENT_UPLOAD_KINDS`, its branch in
`eventUploadConstraints`, its alternative in `parseEventUploadPath`'s regex,
`EVENT_PDF_CONTENT_TYPES`, `EVENT_PDF_MAX_BYTES`, the whole `EventFileField.tsx`
component, and every string naming a proposal.

**Why not keep it optional.** Because an optional field on the *first* screen is still a
screen that asks for a proposal, and the failure mode measured in §0.1 is a head closing
the tab, not a head submitting an incomplete record. Deleting the column also converts
every stale reader into a `tsc` error instead of a silent `undefined` — the mitigation
this codebase's own sentinel-bug-class doc argues for.

**Blob consequence:** no orphaned blobs exist, because no event exists. `del()` calls on
`proposalUrl` (`event.ts:396-413`) are deleted with the field.

### D-2 — The two-phase field split collapses to one rule

`PROPOSAL_EDITABLE` and `PUBLIC_EDITABLE` are both deleted and replaced by one function in
`src/lib/schemas/event.ts`:

```ts
export type EventEditScope = "all" | "public" | "none";
export function editScope(status: EventStatus): EventEditScope
```

| Status | Scope | Meaning |
|---|---|---|
| `draft` | `"all"` | every field writable |
| `changes_requested` | `"all"` | every field writable |
| `published` | `"public"` | `bannerUrl`, `photoUrls`, `publicDescription` only |
| **`submitted`** | **`"none"`** | **LOCKED — under review** |
| `declined` | `"none"` | terminal |
| `canceled` | `"none"` | terminal |

**`submitted` is LOCKED (ruling C-2).** A head who needs to change a submitted event
**withdraws** it first (D-26), which returns it to `draft` and pulls it out of the JCRC
queue. The reviewer therefore never decides text that changed underneath them: an event in
the queue is frozen, and one that is being edited is not in the queue.

**Why a function, not two arrays.** A `switch` over `EventStatus` with no `default` is
exhaustive, so adding a status later is a compile error here rather than a silently-empty
array. And because it is one exported value, `EventManage.tsx` can finally *import* it
instead of re-deriving the branching by hand (§0.3), which is what kills the drift pair.

### D-3 — Heads key in every detail up front; the JCRC reviews a finished event

The create form collects title, description, start, end, location/facility and capacity.
The manage page then collects banner and public description, and `submitForReview`
requires **all** of them. There is no "add the public bits after approval" stage.

**Why.** It is the entire point of the rework: the reviewer's question stops being "is
this proposal acceptable" and becomes "may this go on the hall calendar as written",
which is the question the JCRC said they actually answer.

### D-4 — `approved` is deleted; approval publishes

`decide(decision: "approve")` sets `status = "published"` and stamps `publishedAt`,
`decidedAt`, `decidedBy` in one write. `event.publish` is **deleted** as a procedure.
`event.updatePublicContent` is **merged into** `event.update`.

**Why.** `approved` only ever existed as the waiting room between the JCRC's yes and the
head's banner upload. D-3 moves the banner before the yes, so the waiting room has no
occupant and no exit condition — an `approved` event would be an event that is allowed to
happen and that nobody can see, waiting on a head to press a second button they were never
told about. Free to delete: 0 rows (§0.1).

### D-5 — Rejection splits into `changes_requested` and `declined`

`changes_requested` reopens the event for editing, pins the reason, and the head resubmits
back to `submitted`. `declined` is TERMINAL.

Final vocabulary: **`draft | submitted | published | changes_requested | declined | canceled`.**

**Why.** Today `rejected` means both. `EventsListPanel.tsx:92` renders
`` `JCRC: ${e.decisionReason}` `` for it and `EventManage.tsx:134` titles it *"JCRC asked
for changes"* — so the UI already assumes the softer meaning, and a genuine "no" currently
leaves the event sitting in a permanently re-submittable state. Two words, two behaviours.

### D-6 — The JCRC decides; it never authors

`decide` takes `approve | request_changes | decline`. There is no reviewer edit of any
event field. The reviewer additionally gets `event.reviewerCancel`, which cancels a
**published** event and audits it.

**Why.** A reviewer who can edit is a reviewer who owns the mistake. The feedback channel
is `decisionReason`, which the head sees pinned (§8.4).

### D-7 — `Event.ccaID` becomes nullable; `null` = hall-wide, JCRC-owned

**Why it is safe here specifically.** `null` vs absent is the bug class this repo has
already remediated, and the reason it bites is legacy rows written before a field existed.
`Event` has **0 rows** (§0.1), so `null` is the *only* absent value this collection will
ever hold — every row is written by code that ships in this change. That property is
consumed once and never again: do not use this argument for any other collection.

Every reader goes through §7's census; the ones TypeScript cannot catch are §7.2.

**Two collections, two different "no CCA" spellings, and that is correct.** `Event.ccaID`
is `null`; `Bookings.ccaID` is `0`. They are not in conflict because they are different
namespaces with different constraints: `Bookings.ccaID` is a required `Int` with 3,839 rows
already spelling absence as `0` (§0.5), while `Event.ccaID` is a brand-new nullable on an
empty collection. Note also that `ccaIDField` (`schemas/event.ts:176`) is
`z.number().int().positive()`, so **`0` is not even expressible** as an `Event.ccaID` at the
input layer — the two encodings cannot be confused by a client. Do not "harmonise" them.

**"Hall-wide" and "the CCA was deleted" must be told apart by `ccaID`, never by `ccaName`.**
`deleteCcaCascade` does not remove a CCA's events (T-2), so an orphaned event already
resolves `ccaName: null` today and renders `CCA #123`. If `null` *name* started meaning
"Hall", an orphan would be relabelled as a hall event. `ownerLabel` (§5.10) therefore keys
on **`ccaID == null`**, and falls through to `CCA #{id}` when the id is present but
unnameable. This is why the helper takes both arguments.

### D-8 — A hall-wide event's auto-booking uses `ccaID: 0`, NOT null. `Bookings` does not change.

```ts
// event.ts, inside decide's auto-book block
ccaID: event.ccaID ?? 0,   // 0 = the reserved "no CCA" sentinel — see cascade.ts:47
```

**Why.** §0.5: `Bookings.ccaID` is a required `Int`, `0` is already the reserved
"no CCA" value, 3,839 production rows carry it, `BookingModal.tsx:115` writes it, and
`cascade.ts:47` guards it. Introducing `null` there would create a **second** value meaning
absent in a collection that already has one — the exact sentinel-as-value bug class this
repo has remediated. `Bookings` schema is untouched.

The type system enforces this: `BookingsCreateInput.ccaID` is `number`, so
`ccaID: event.ccaID` (now `number | null`) **will not compile**. See T-1.

`cascade.ts` needs **no change** and behaves correctly: `deleteCcaCascade(0)` still throws
`RESERVED_CCAID`, so a hall event's booking can never be swept up by a CCA delete. §12 T-2
records the one interaction that *is* worth knowing.

### D-9 — A new capability, `manageHallEvents`

Added to `Capabilities` and `computeCapabilities` in `src/server/api/services/roles.ts`,
computed as `manager` (i.e. `admin || jcrc`), exactly like `reviewEvents` at `:1303`.

**`scrc` is deliberately absent.** The hall office's whole events reach is
`viewEventsReadOnly` (`roles.ts:1319`), described in its own comment as "view events,
read-only". Authorship is not read-only. `oversightProcedure` must not gain a write.

**Why a new field rather than reusing `reviewEvents`.** Reviewing and authoring are
different powers over the same object, and today they happen to belong to the same tier.
Sharing one field means the day someone widens the review queue by one role, they hand out
hall-wide authorship as a side effect — the same argument `roles.ts:1304-1307` makes for
keeping `manageCcaRecruitment` off `manageCcas`.

### D-10 — Every owner-display site renders "Hall" when `ccaID` is null

Complete, grep-verified census in §7. Verbatim string in §8.1.

### D-11 — Duplicate copies an event into a fresh `draft`

`event.duplicate` copies `ccaID` (including null), `title` (suffixed, §8.7),
`description`, `startTime`, `endTime`, `location`, `facilityID`, `capacity`,
`publicDescription`. It resets `status` to `"draft"` and sets `decidedAt`, `decidedBy`,
`decisionReason`, `publishedAt`, `bookingID`, `autoBookFailed` to null/false.

**It does NOT copy `bannerUrl` or `photoUrls`.** See D-19 and T-3 — this is not an
oversight, it is forced by the blob security model.

No series or recurrence model. A recurring event is N duplicates, which is what the heads
asked for and costs no schema.

### D-12 — Facility auto-booking on approval is kept as-is

The `withFacilityLock` + overlap-check + `nextBookingId` block at `event.ts:874-944` moves
intact into the new `approve` branch, with D-8's `?? 0` and nothing else changed. It stays
best-effort: a clash sets `autoBookFailed` and **never** blocks the decision
(`event.ts:925-943`).

### D-13 — `EventLock`, capacity enforcement, signup, `exportAttendees` are untouched

`withEventLock` (`services/events.ts:121`), the capacity check (`event.ts:1254-1272`), the
`P2002` idempotency backstop (`:1277-1288`) and the audited PII export (`:749-786`) are not
edited in this phase beyond what the status rename forces.

### D-14 — `draft` is a technical staging state a head is never parked in

`draft` survives for exactly one reason: `eventUploadPath(eventID, kind)`
(`schemas/event.ts:126`) needs an `eventID` before a banner can be uploaded, so a row must
exist first.

**How the UI prevents parking (this is the spec, not advice):**

1. `EventCreateForm`'s primary button is **"Continue"**, not "Save draft" (§8.2). It
   creates the row and routes straight to the manage page in the same interaction —
   `create.mutate` → `onSuccess` → `router.push`, as it already does at
   `EventCreateForm.tsx:27-31`. The head never sees the word "draft" on that screen.
2. The manage page for a `draft` shows the full editor with **one** primary button,
   "Submit for review", and a secondary "Save and finish later".
3. `EventsListPanel` renders any `draft` row with the badge **"Not submitted"** (§8.1) and
   a **"Finish and submit"** link, not a neutral card.
4. `STATUS_META.draft.label` becomes `"Not submitted"` (§8.1). The word "Draft" does not
   appear in any head-facing surface.

### D-15 — The kill switch stays

`assertEventsEnabled(ctx.db)` remains the first line of every procedure in the router,
including the three new ones. `areEventsEnabled` is also the first check in the upload
route (`route.ts:44`). `services/events.ts` is otherwise unchanged.

### D-16 — Index census before and after. See C-1: no `db push`.

§9. The census is mandatory; the push is not, and should not be run.

### D-17 — Four inert fields land now

`attendanceOpensAt Int?`, `attendanceClosesAt Int?`, `scannerUserIDs String[] @default([])`,
`answersPurgedAt DateTime?`. All nullable or defaulted (invariant I-2). No procedure reads
or writes them in Phase 1. They exist so the attendance phase needs no second schema pass.

### D-18 — Out of scope

Custom question builder, QR attendance / door scanner, dashboards, notifications, the
60-day answer purge. Do not spec, build, or reference them beyond D-17's fields.

---

### D-19 — Duplicate does not copy images (forced, not chosen)

`isOwnEventBlobUrl(url, eventID, kind)` (`schemas/event.ts:155-169`) requires the URL's
path to start with `/event/{eventID}/{kind}`. A banner copied from event 12 lives at
`event/12/banner-Xy7Qa1.webp` and so **fails validation for event 13** — the first save of
the duplicate would be rejected with `NOT_A_VALID_EVENT_BLOB_URL`, from the very check
that is the security boundary.

Copying the blob server-side is the alternative and is rejected for this phase: it means a
server-side `put()` per image, a new failure mode inside a mutation that currently cannot
fail on I/O, and orphan cleanup if the duplicate is later discarded. The duplicate starts
with no images and says so (§8.7).

### D-20 — Hall-wide events are authored at `/admin/events`, not `/cca/...`

`EventManage` is routed at `/cca/[ccaID]/events/[eventID]`. A hall event has no `ccaID`, so
that route cannot address it. New routes:

```
/admin/events                     review queue (existing) + "Hall events" section (new)
/admin/events/hall/new            create a hall event
/admin/events/hall/[eventID]      manage a hall event
```

`EventManage` and `EventsListPanel` are generalised to `ccaID: number | null` plus an
explicit `backHref`, so one component serves both surfaces. `/admin/events/layout.tsx:33`
currently gates on `reviewEvents`; it becomes
`reviewEvents || manageHallEvents` (identical set today — both are `manager` — but it
states the right reason, so widening one later does not silently widen the other).

### D-21 — `canceled` is reachable from every non-terminal state; there is no delete path

Head: `draft | submitted | changes_requested | published → canceled`.
Reviewer (`event.reviewerCancel`): `published → canceled` only.

**Cancel and withdraw are different acts and must not be merged.** `withdraw` (D-26) means
*"I am still doing this event, stop reviewing it for a moment"* and returns to `draft`.
`cancelEvent` means *"this event is not happening"* and is terminal. Offering one button
for both is how a head loses an event they meant to edit.

**Why no hard delete for an unsubmitted event.** A delete path over a collection keyed by
a counter is a new destructive primitive, and "I changed my mind" and "we are calling this
off" are the same fact about the same row. One terminal word, one audit row, nothing
removed. `declined` and `canceled` both refuse further transitions.

### D-22 — Audit vocabulary

In `AUDIT_ACTIONS` (`roles.ts:231-235`), which today reads
`event.approve | event.reject | event.publish | event.cancel | event.attendees.export`:

| Action | Fate | Chars |
|---|---|---|
| `event.approve` | **keep** — now means approved *and* published | 13 |
| `event.reject` | **remove** — replaced by the two below | — |
| `event.publish` | **remove** — folded into `event.approve` | — |
| `event.changes` | **add** — changes requested | 13 |
| `event.decline` | **add** — terminal refusal | 13 |
| `event.submit` | **add** — head submitted / resubmitted (C-3) | 12 |
| `event.withdraw` | **add** — head pulled it back out of the queue (D-26) | 14 |
| `event.duplicate` | **add** | 15 |
| `event.cancel` | keep — head *and* reviewer; `actorRoles` distinguishes | 12 |
| `event.attendees.export` | keep, untouched | 22 |

All under the 32-char cap `admin.listAuditLog`'s `action: z.string().max(32)` filter
imposes (`admin.ts:3035`).

**Removing two strings is safe only because of §0.1**: 0 stored rows carry them, so no
existing row becomes unfilterable. Re-measure before deleting (§9.1).

There is deliberately **no** separate `event.cancel.jcrc`: `writeAudit` denormalises
`actorRoles` onto the row (`admin.ts:442`), so `actorRoles contains "jcrc"` already selects
reviewer cancellations — the same argument `roles.ts:270-274` makes for `scrc` role changes.

**The hall-event self-approval trail (D-27).** "Register and publish" writes **two** rows —
`event.submit` then `event.approve` — with the same `actorUserID`, seconds apart, on the
same `targetEventID`. That pairing is the audit record of a self-approval and it must stay
legible: do **not** collapse the two calls into one row, and do **not** suppress the
`event.submit` row because "nobody reviewed it". Two rows with one actor is precisely the
fact an auditor needs to see.

### D-23 — `decide` folds in publishing but keeps its live capability re-check

`decide` stays on `roleManagerProcedure` and keeps the inline
`computeCapabilities(roles).reviewEvents` re-check at `event.ts:836-841`, with `roles` from
a live `getUserRoles` (I-5). Folding `publish` into it does not relax that. `oversightProcedure`
still does not reach it (`event.ts:962-982` explains why; that comment stays true and stays).

### D-24 — `getPublic` and `listPublished` are unchanged in what they expose

`toPublicCard` (`event.ts:185-211`) already omits `description`, `proposalUrl`,
`decisionReason` and every canonical-id field. Its parameter type gains `ccaID: number | null`
and nothing else. `SCRC_HIDDEN_EVENT_FIELDS` (`event.ts:273-280`) **loses its
`proposalUrl: null` line** when the column goes — the `satisfies Partial<Record<keyof Event, null>>`
clause turns that into a compile error if the coder forgets, which is the intended behaviour
of that clause (`event.ts:266-269`).

### D-25 — `normalizeStatus`'s fallback stays `"draft"`

`schemas/event.ts:44-48` maps null and anything unrecognised to `"draft"`. Under the new
vocabulary that is still the right floor: an unrecognised value is a thing that has not
been submitted. `listForOversight`'s known raw-vs-normalised filter caveat
(`event.ts:1044-1051`) stays true verbatim and its comment is kept.

### D-26 — `withdraw`: `submitted → draft`, head-only, audited (ruling C-2)

`event.withdraw` takes `{ eventID }`, is authorised by `loadOwnedEvent` (so: the owning CCA
head, or — for a hall event — a holder of `manageHallEvents`), refuses any status other
than `submitted`, and writes:

```
status: "draft", decidedAt: null, decidedBy: null, decisionReason: null,
updatedAt: now, updatedBy: userID
```

then audits `event.withdraw`.

**It removes the event from the JCRC queue as a side effect, not as a separate step.**
`listForReview` filters `where: { status: "submitted" }` (`event.ts:793`), so the status
write *is* the removal. No queue table to maintain, nothing to keep in sync.

**Why a distinct transition rather than just unlocking `submitted`.** Unlocking is what
C-2 rejected. A withdrawal is an event the reviewer can *observe* — the item leaves the
queue, and when it returns it returns as a new submission with a fresh `updatedAt`, sorted
to the back of a queue ordered `updatedAt asc`. Silent editing gives the reviewer no signal
at all.

**Why `decidedAt` / `decidedBy` / `decisionReason` are cleared.** The same three fields
`submitForReview` already clears (`event.ts:454-457`). A withdrawn event carries no
decision, and leaving a stale `changes_requested` reason attached to a `draft` would render
the "JCRC asked for changes" panel on an event the JCRC is no longer looking at.

**The reviewer-side race is real and is handled** — see T-10 and the copy in §8.12.

### D-27 — Hall events: one "Register and publish" action (ruling T-11)

For a hall-wide event (`ccaID == null`) **only**, the head-side surface offers a single
affordance that runs, in sequence:

```
1. event.submitForReview({ eventID })      -> status "submitted", audits event.submit
2. event.decide({ eventID, decision: "approve" }) -> status "published", audits event.approve,
                                                     stamps publishedAt, runs auto-book (D-12)
```

**Both calls re-check capabilities LIVE.** `submitForReview` goes through `loadOwnedEvent`
(→ `manageHallEvents`); `decide` performs its own `getUserRoles` +
`computeCapabilities(roles).reviewEvents` re-check at `event.ts:836-841`. **Neither is
skipped, short-circuited, or replaced by a combined server procedure**, because that
re-check is the guard that catches a role revoked mid-session (I-5), and a fused procedure
would have to re-implement it — a second copy of the one check that must not have a second
copy.

**No half-state.** If step 2 fails for any reason, the event **stays at `submitted`** and
is visible in the JCRC queue like any other. It is not rolled back to `draft`: `submitted`
is a legitimate, recoverable state that any reviewer (including the actor, by retrying) can
resolve, whereas a silent rollback would discard a real submission. The client surfaces the
step-2 failure verbatim (§8.13) and the head may retry or leave it for the queue.

**Why this is not a governance hole.** For a hall-wide event the JCRC *is* the reviewing
authority — there is no third party whose approval is being bypassed. What matters is that
the record shows it: D-22 requires both audit rows, same actor, so "the JCRC published its
own event without external review" is a one-query fact rather than an inference.

**CCA events do not get this button.** It is rendered only when `ccaID == null`. A CCA head
must never see it, and the server does not need to enforce that separately — `decide`'s
`reviewEvents` check already refuses them.

---

## 2. The status machine

Six states. Enforced in the router, never by the DB (`Event.status` is
`String? @default(...)`, `schema.prisma:746`).

```
                       EDITABLE                    LOCKED
                  ┌───────────────────┐    ┌────────────────────┐
                  │                   │    │                    │
   (create)       │   ┌─────────┐     │    │   ┌───────────┐    │
      └───────────┼──►│  draft  │─────┼────┼──►│ submitted │    │
                  │   └─────────┘  submit   │   └───────────┘    │
                  │        ▲        │  │    │      │  │  │       │
                  │        └────────┼──┼────┼──────┘  │  │       │
                  │      withdraw   │  │    │         │  │       │
                  │  ┌───────────────┐ │    │         │  │       │
                  │  │ changes_      │◄┼────┼─────────┘  │       │
                  │  │ requested     │ │  request_       │       │
                  │  └───────────────┘ │  changes        │ decline
                  │        │           │    │            │       │
                  └────────┼───────────┘    └────────────┼───────┘
                           │  submit                     ▼
                           └──────────► (submitted)   ┌──────────┐
                                                      │ declined │ TERMINAL
                            approve                   └──────────┘
                  submitted ────────► ┌───────────┐
                                      │ published │  (banner / photos /
                                      └───────────┘   public description
                                            │         still editable)
                                            │
   cancelEvent  (draft | submitted | changes_requested | published)
   reviewerCancel (published only)          │
                           └────────────────┴──────► ┌──────────┐
                                                     │ canceled │ TERMINAL
                                                     └──────────┘

   HALL EVENTS ONLY (D-27): "Register and publish" = submitForReview then
   decide(approve), run back-to-back by the client. Both audit; both re-check
   capabilities live. If step 2 fails the event STAYS at `submitted`.
```

**Read the two boxes at the top first.** `draft` and `changes_requested` are the editable
states; `submitted` is **locked** (ruling C-2). The only way back from `submitted` to an
editable state is **`withdraw`**, which is a real, audited, reviewer-visible transition —
not a silent unlock.

### 2.1 Legal transitions, exhaustively

| # | From | To | Procedure | Actor | Guards |
|---|---|---|---|---|---|
| T1 | *(none)* | `draft` | `event.create` | head of `ccaID`, or `manageHallEvents` when `ccaID` omitted | `assertEventsEnabled`; `assertHeadsCca` or capability; CCA must exist when `ccaID` given |
| T2 | `draft` | `submitted` | `event.submitForReview` | owner | `editScope === "all"`; completeness (§2.2); audits `event.submit` |
| T3 | `changes_requested` | `submitted` | `event.submitForReview` | owner | same as T2; **clears** `decidedAt`/`decidedBy`/`decisionReason` |
| **T3a** | **`submitted`** | **`draft`** | **`event.withdraw`** | **owner** (owning CCA head, or `manageHallEvents` for a hall event) | status **must be** `submitted`, else `NOT_WITHDRAWABLE`; clears `decidedAt`/`decidedBy`/`decisionReason`; **removes it from the JCRC queue as a side effect** (`listForReview` filters `status: "submitted"`); audits `event.withdraw`. **D-26.** |
| T4 | `submitted` | `published` | `event.decide` (`approve`) | `reviewEvents` (live re-check) | status **must be** `submitted`; stamps `publishedAt`, `decidedAt`, `decidedBy`; runs auto-book (D-12); audits `event.approve` |
| T5 | `submitted` | `changes_requested` | `event.decide` (`request_changes`) | `reviewEvents` | reason **required**; audits `event.changes` |
| T6 | `submitted` | `declined` | `event.decide` (`decline`) | `reviewEvents` | reason **required**; TERMINAL; audits `event.decline` |
| T7 | `draft`\|`submitted`\|`changes_requested`\|`published` | `canceled` | `event.cancelEvent` | owner | deletes the auto-booking if `bookingID != null`; nulls `bookingID`; audits `event.cancel` |
| T8 | `published` | `canceled` | `event.reviewerCancel` | `reviewEvents` | reason **required**; same booking cleanup; audits `event.cancel` |
| T9 | `draft`\|`changes_requested` | *(same)* | `event.update` | owner | `editScope === "all"` → all fields writable. **`submitted` is NOT in this list** (C-2) — an update against it is refused with `EVENT_LOCKED`. |
| T10 | `published` | *(same)* | `event.update` | owner | `editScope === "public"` → only `bannerUrl`, `photoUrls`, `publicDescription` |
| T11 | any | `draft` (new row) | `event.duplicate` | owner of the source | creates a **new** event; source untouched |
| **T12** | `draft` | `published` | **`event.submitForReview` then `event.decide(approve)`** — two calls, client-sequenced | `manageHallEvents` **and** `reviewEvents`, each re-checked live in its own call | **hall events only** (`ccaID == null`). Not a new transition: it is T2 followed by T4. Writes **two** audit rows (`event.submit`, `event.approve`) with the same actor. On step-2 failure the event stays at `submitted`. **D-27.** |

**No other transition exists.** In particular:

- `submitted` accepts no edit — only `withdraw` (T3a), a `decide` outcome (T4/T5/T6), or
  `cancelEvent` (T7).
- `declined` and `canceled` accept nothing at all (`editScope === "none"`, and every
  mutation above rejects them).
- `published → submitted` does not exist. A published event that needs re-review is
  cancelled and duplicated.
- There is **no** server-side "register and publish" procedure. T12 is two existing calls
  in sequence, deliberately (D-27).

### 2.2 Completeness required to leave `draft` / `changes_requested`

`submitForReview` refuses with `INCOMPLETE:<csv>` unless **all** of:

| Field | Rule |
|---|---|
| `title` | non-empty after trim |
| `description` | non-empty after trim |
| `startTime` | not null |
| `endTime` | not null **when `facilityID != null`** (an auto-booking needs a definite end) |
| `location` | non-empty after trim |
| `capacity` | *not required* — null means unlimited |
| `bannerUrl` | not null ← **new**, moved forward from `publish` |
| `publicDescription` | non-empty after trim ← **new**, moved forward from `publish` |

The last two are exactly the `publish` guard at `event.ts:539-547`, relocated. That is D-3
expressed as a single check, and it is why `publish` has nothing left to do.

`FIELD_LABELS` in `EventManage.tsx:32-41` maps these to prose; §8.5 gives the new map
(`proposalUrl` removed).

---

## 3. `prisma/schema.prisma` — the diff

### 3.1 Replace the doc comment above `model Event` (lines 713-717)

Currently:

```prisma
/// status vocabulary (enforced in code, src/lib/schemas/event.ts):
///   draft | submitted | approved | rejected | published | canceled
/// `draft` exists so the proposal PDF (which needs an eventID in its blob path)
/// can be uploaded before "Submit for review". `rejected` is editable and
/// resubmittable; `canceled` is terminal.
```

Becomes:

```prisma
/// status vocabulary (enforced in code, src/lib/schemas/event.ts):
///   draft | submitted | published | changes_requested | declined | canceled
/// `draft` is a TECHNICAL STAGING STATE ONLY: a row must exist before its banner
/// can be uploaded, because the blob path is event/{eventID}/banner. No head is
/// ever parked in it — the create form routes straight through, and the head
/// surface labels it "Not submitted". `changes_requested` is editable and
/// resubmittable. `declined` and `canceled` are TERMINAL. There is no `approved`:
/// approval publishes in one write (event.decide), so an event is never in the
/// state "allowed to happen but invisible".
```

### 3.2 `ccaID` becomes nullable

```prisma
  /// NULL means a HALL-WIDE event owned by the JCRC, not a CCA event.
  ///
  /// Safe as a nullable here and NOWHERE ELSE by default: this collection had
  /// ZERO rows when the field was relaxed (measured 2026-08-26), so `null` is the
  /// only absent value it will ever hold — every row is written by code that
  /// knows about hall events. Do not copy this argument to a populated model.
  ///
  /// AUTHORISATION BRANCHES ON IT: a non-null value goes to assertHeadsCca; null
  /// requires the `manageHallEvents` capability. See loadOwnedEvent in
  /// routers/event.ts — never re-derive that branch inline.
  ///
  /// IT IS NOT THE BOOKING'S ccaID. A hall event's auto-created Bookings row
  /// carries ccaID 0, the reserved "no CCA" sentinel (services/cascade.ts:47,
  /// BookingModal.tsx). Bookings.ccaID is a required Int and MUST NOT become
  /// nullable — two values meaning absent is the bug class this repo has already
  /// remediated once.
  ccaID             Int?
```

### 3.3 Delete `proposalUrl` (lines 727-730)

Remove the field and its four-line doc comment entirely.

### 3.4 Add the four inert fields (D-17)

Placed in their own block after `publishedAt`, above the `createdAt` block:

```prisma
  // ---- Reserved for the attendance phase. INERT in Phase 1: no procedure in
  // routers/event.ts reads or writes any of these. They are added now so the
  // attendance work needs no second schema pass. All nullable or defaulted (I-2).
  /// UNIX epoch SECONDS, UTC — when the door scanner starts accepting check-ins.
  attendanceOpensAt   Int?
  /// UNIX epoch SECONDS, UTC — when it stops.
  attendanceClosesAt  Int?
  /// CANONICAL userIDs (I-1) permitted to scan at the door. Empty = nobody.
  scannerUserIDs      String[]  @default([])
  /// Set when this event's custom-question answers were purged. Null = not purged.
  answersPurgedAt     DateTime?
```

### 3.5 Indexes — unchanged

`@@index([ccaID, status], map: "cca_status")` stays. A partial index would be tempting for
"hall events only", and is not added: Mongo indexes null fine, the collection is empty, and
adding an index is the one thing that would force the `db push` C-1 argues against.

### 3.6 `model Bookings` — NO CHANGE

Stated as a line item so its absence from the diff is deliberate and reviewable. See D-8.

---

## 4. `src/lib/schemas/event.ts` — the diff

Total change is large enough that the coder should work top-to-bottom.

| Lines | Change |
|---|---|
| `17-37` | Rewrite the docblock and `EVENT_STATUSES` to the six-word vocabulary (§2). |
| `39-42` | **Delete** `PROPOSAL_EDITABLE` and `PUBLIC_EDITABLE`. Add `EventEditScope` + `editScope(status)` (D-2), an exhaustive `switch` with no `default` so a new status is a compile error. **`submitted` maps to `"none"`** (ruling C-2) — if the coder writes `"all"` there, every guarantee in §2 collapses and nothing else in the build will complain. |
| `44-48` | `normalizeStatus` unchanged (D-25). |
| `85-86` | `EVENT_UPLOAD_KINDS` → `["banner", "photo"] as const`. |
| `93`, `98` | **Delete** `EVENT_PDF_CONTENT_TYPES` and `EVENT_PDF_MAX_BYTES`. |
| `104-118` | `eventUploadConstraints` loses the `if (kind === "proposal")` branch and becomes a single return. Keep the function (the route calls it, and the next kind will need it back). |
| `140` | Regex → `/^event\/(\d+)\/(banner|photo)$/`. |
| `155-169` | `isOwnEventBlobUrl` unchanged. It is the load-bearing check; do not touch it. |
| `202-217` | `createDraftInput` → rename to **`createEventInput`**. `ccaID` becomes `ccaIDField.nullable().optional()` — **absent or null means hall-wide**. Keep every other field optional (the create form still saves partial progress; completeness is a submit-time check, §2.2). |
| `224-249` | `updateDraftInput` + `updatePublicContentInput` **merge** into one `updateEventInput` carrying every field: `title`, `description`, `startTime`, `endTime`, `location`, `facilityID`, `capacity`, `publicDescription`, `bannerUrl`, `photoUrls`. Drop `proposalUrl`. Keep `refineTimes`. Keep the `isOwnEventBlobUrl` superRefines for `bannerUrl` and `photoUrls` **verbatim** — they are the security boundary. The server, not the schema, decides which subset a given status accepts (§5.3). |
| `293-308` | `decideInput.decision` → `z.enum(["approve", "request_changes", "decline"])`. The superRefine requires `reason` for **both** `request_changes` and `decline`; message per §8.8. |
| new | `reviewerCancelInput = z.object({ eventID, reason: z.string().trim().min(1).max(EVENT_DECISION_REASON_MAX) })`. |
| new | `withdraw` needs no schema of its own — it reuses `eventIdInput` (D-26). |
| `310-311` | `eventIdInput`, `ccaIdInput` unchanged. |

**Why the zod schema does not encode the per-status field subset.** Zod runs on the client
too, and the client does not know the stored status at parse time (it knows what it
fetched, which may be stale). Making the schema permissive and the server strict means the
server is the only authority — the same reasoning as `updateDraft`'s merge-then-check at
`event.ts:354-365`.

---

## 5. `src/server/api/routers/event.ts` — procedure by procedure

Current: 21 procedures, 1337 lines. After: **22 procedures**.

*(Corrected during review. This line previously read "After: 20", which
contradicted §5.1's own table. The arithmetic: 21 − 2 deleted
(`updatePublicContent`, `publish`) + 3 new (`withdraw`, `reviewerCancel`,
`duplicate`) = 22. `createDraft→create`, `updateDraft→update`,
`listMineForCca→listForOwner` and `getForHead→getForOwner` are renames and do
not change the count. The TABLE below was right and enumerates all 22; only this
total was wrong, so the built set is correct — verified against the router.)*

### 5.1 Procedure table

| Current | Fate |
|---|---|
| `createDraft` `:293` | → **`create`**. `ccaID` optional; hall branch. |
| `updateDraft` `:339` | → **`update`** (merged, below). |
| `updatePublicContent` `:465` | → **merged into `update`**. Delete. |
| `publish` `:522` | → **deleted**. Folded into `decide`. |
| — | **new `withdraw`** (T3a, D-26). |
| `submitForReview` `:417` | kept; completeness gains banner + publicDescription (§2.2); audits `event.submit`. |
| `cancelEvent` `:569` | kept; widened to T7's four source states. |
| — | **new `reviewerCancel`** (T8). |
| — | **new `duplicate`** (T11). |
| `listMineForCca` `:626` | → **`listForOwner`**, input `{ ccaID: number \| null }`. |
| `getForHead` `:657` | → **`getForOwner`**. |
| `getSignupStats` `:670` | kept; auth helper swap only. |
| `getAttendees` `:713` | kept; auth helper swap only. |
| `exportAttendees` `:749` | kept; `targetCcaID: event.ccaID ?? undefined`. |
| `listForReview` `:790` | kept; `ccaName` becomes `"Hall"` for null. |
| `getForReview` `:813` | kept; same. |
| `decide` `:830` | rewritten (§5.2). |
| `listForOversight` `:1011` | kept; same. |
| `getForOversight` `:1106` | kept; `SCRC_HIDDEN_EVENT_FIELDS` loses `proposalUrl` (D-24). |
| `listPublished` `:1149` | kept; same. |
| `getPublic` `:1185` | kept; same. |
| `signup` `:1232` | untouched. |
| `cancelSignup` `:1293` | untouched. |
| `listMySignups` `:1304` | kept; `ccaName` handling only. |

### 5.2 `decide` — the rewrite

```
1. assertEventsEnabled
2. userID = ctx.session.user.userID
3. roles = await getUserRoles(...)                       // I-5 live read — keep
4. if (!computeCapabilities(roles).reviewEvents) FORBIDDEN CAPABILITY_REQUIRED:reviewEvents
5. event = findUnique({ eventID }); NOT_FOUND if absent
6. if (normalizeStatus(event.status) !== "submitted") PRECONDITION_FAILED NOT_UNDER_REVIEW
7. nextStatus = approve ? "published" : request_changes ? "changes_requested" : "declined"
8. updateMany scoped on the status — NOT a bare `update`; see T-10 point 4:
     where: { eventID, status: "submitted" }
     data:  { status: nextStatus, decidedAt: now, decidedBy: userID,
              decisionReason: input.reason ?? null,
              ...(approve ? { publishedAt: new Date() } : {}) }
   if count === 0 -> PRECONDITION_FAILED NOT_UNDER_REVIEW
9. if (approve && facilityID != null && startTime != null && endTime != null):
     the EXISTING block from :874-944, verbatim, with ONE edit:
        ccaID: event.ccaID ?? 0        // D-8
10. writeAudit({ ..., targetCcaID: event.ccaID ?? undefined,
                 targetEventID: event.eventID,
                 action: approve ? "event.approve"
                       : request_changes ? "event.changes" : "event.decline",
                 reason: <the autoBook-decorated reason, as :952-957 already builds it> })
11. return { status: nextStatus, autoBook }
```

Steps 4, 6 and the auto-book block's best-effort contract (D-12) are unchanged in
behaviour. **Step 9's one edit is the single most important line in this plan** (T-1).

Optional cleanup, explicitly allowed: the inline overlap query at `event.ts:886-895`
duplicates `findFacilityConflict` (`services/booking.ts:91-106`) — same half-open predicate,
different code. Replacing the inline query with the helper is behaviour-identical and
removes a drift pair. Do it or don't; do not "improve" the predicate either way.

### 5.3 `update` — the merge

```ts
update: identifiedProcedure.input(updateEventInput).mutation(async ({ ctx, input }) => {
  await assertEventsEnabled(ctx.db);
  const userID = ctx.session.user.userID;
  const roles = await getUserRoles(ctx.db, userID);            // I-5
  const event = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

  const scope = editScope(normalizeStatus(event.status));
  if (scope === "none") throw PRECONDITION_FAILED "EVENT_LOCKED";
  // ... build `data` from the fields this scope permits, ignoring the rest
})
```

- `scope === "none"` → refused. **This now includes `submitted`** (ruling C-2), alongside
  `declined` and `canceled`. A head who wants to edit a submitted event calls
  `event.withdraw` first (D-26). The client must not paper over this by auto-withdrawing:
  withdrawing is a decision with a visible consequence for the reviewer, so it is an
  explicit button with its own confirmation (§8.12).
- `scope === "all"` → every field in `updateEventInput` is written when present. Reachable
  from `draft` and `changes_requested` only.
- `scope === "public"` → **only** `bannerUrl`, `photoUrls`, `publicDescription`.
  A payload carrying `title` while published is **not** an error; the field is silently
  ignored. *Rationale:* the head's browser may hold a stale status, and erroring would
  lose their banner edit to a race. The server states the truth; the UI does not offer the
  fields (§6).
- Merge-then-check for times survives verbatim from `:354-365` — a client may send
  `endTime` alone.
- Facility ↔ location resolution survives verbatim from `:379-391`.
- Blob cleanup on replace survives from `:491-518` (banner + photos). The `proposalUrl`
  cleanup block at `:396-413` is deleted with the field.
- **No audit row** (C-3: field saves are not transitions).

### 5.4 `loadHeadedEvent` → `loadOwnedEvent`

The single most important helper change. Currently `event.ts:80-92`:

```ts
await assertHeadsCca(db, { userID, roles }, event.ccaID);
```

Becomes — and this is the ONLY place the branch may live:

```ts
/**
 * Load an event and prove the caller OWNS it.
 *
 * TWO ownership shapes, and the ccaID on the STORED row picks between them:
 *   ccaID != null  a CCA event -> assertHeadsCca on that ccaID (per-object, never
 *                  a role string; `cca_head` is scope-free)
 *   ccaID == null  a HALL-WIDE event -> the `manageHallEvents` capability
 *
 * The ccaID comes from the row, never the client, so a head cannot reach a
 * foreign event by supplying a ccaID — and cannot reach a HALL event by
 * supplying null, because they supply nothing at all.
 *
 * DO NOT INLINE THIS BRANCH ANYWHERE ELSE. A second copy is a second chance to
 * get the null case wrong, and the null case is the authorisation case.
 */
async function loadOwnedEvent(db, userID, roles, eventID) {
  const event = await db.event.findUnique({ where: { eventID } });
  if (!event) throw new TRPCError({ code: "NOT_FOUND", message: "NO_SUCH_EVENT" });
  if (event.ccaID == null) {
    if (!computeCapabilities(roles).manageHallEvents) {
      throw new TRPCError({ code: "FORBIDDEN", message: "CAPABILITY_REQUIRED:manageHallEvents" });
    }
  } else {
    await assertHeadsCca(db, { userID, roles }, event.ccaID);
  }
  return event;
}
```

Every current caller of `loadHeadedEvent` switches: `updateDraft`→`update` `:345`,
`submitForReview` `:423`, `updatePublicContent`→merged `:471`, `publish` (deleted) `:528`,
`cancelEvent` `:575`, `getForHead`→`getForOwner` `:663`, `getSignupStats` `:676`,
`getAttendees` `:719`, `exportAttendees` `:755`.

### 5.5 `create`

```
1. assertEventsEnabled
2. roles = live getUserRoles                                  // I-5
3. if (input.ccaID == null) {
     require computeCapabilities(roles).manageHallEvents
     ccaID = null
   } else {
     await assertHeadsCca(db, { userID, roles }, input.ccaID)
     const cca = await db.cCA.findUnique({ where: { ccaID: input.ccaID }, select: { ccaID: true } })
     if (!cca) NOT_FOUND "NO_SUCH_CCA"                        // keep — :303-307
     ccaID = input.ccaID
   }
4. resolve facility → { facilityID, location }                // keep :309-317 verbatim
5. eventID = await nextEventId(db)
6. create { eventID, ccaID, createdBy: userID, ...fields, status: "draft", createdAt: now }
7. return { eventID }
```

**The `NO_SUCH_CCA` check must not be skipped on the hall branch** and must not be
"generalised" into a null-tolerant lookup: `findUnique({ where: { ccaID: null } })` is not
a meaningful query, and a version of this that checks the CCA exists *before* branching
would refuse every hall event. Branch first, then check.

### 5.6 Audit sites

**The rule, stated once and applied without exception (ruling C-3):**

> **State-machine transitions are audited. Field saves are not.**

So `create` and `update` write **no** audit row, and every transition below writes exactly
one. Every one passes
`targetCcaID: event.ccaID ?? undefined` — `AuditEntry.targetCcaID` is `number | undefined`
(`admin.ts:410`), so passing `number | null` is a **compile error**, which is how the
coder finds all four existing sites (`:561`, `:616`, `:780`, `:949`).

| Procedure | Action | `reason` |
|---|---|---|
| `submitForReview` | `event.submit` | `event.title ?? undefined` |
| `withdraw` | `event.withdraw` | `event.title ?? undefined` |
| `decide` (approve) | `event.approve` | existing autoBook-decorated string (`:952-957`) |
| `decide` (request_changes) | `event.changes` | `input.reason` |
| `decide` (decline) | `event.decline` | `input.reason` |
| `cancelEvent` | `event.cancel` | `event.title ?? undefined` |
| `reviewerCancel` | `event.cancel` | `input.reason` |
| `duplicate` | `event.duplicate` | `` `from #${source.eventID}` `` |
| `exportAttendees` | `event.attendees.export` | unchanged (`${n} attendee(s)`) |
| `create` | **none** | — |
| `update` | **none** | — |

A hall event published via "Register and publish" (D-27) therefore produces **two** rows —
`event.submit` and `event.approve` — same `actorUserID`, same `targetEventID`, seconds
apart. That is the intended, legible record of a self-approval; do not collapse it.

### 5.7 `withdraw` — the new procedure (D-26)

```ts
withdraw: identifiedProcedure.input(eventIdInput).mutation(async ({ ctx, input }) => {
  await assertEventsEnabled(ctx.db);
  const userID = ctx.session.user.userID;
  const roles  = await getUserRoles(ctx.db, userID);              // I-5 live read
  const event  = await loadOwnedEvent(ctx.db, userID, roles, input.eventID);

  if (normalizeStatus(event.status) !== "submitted") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_WITHDRAWABLE" });
  }

  // SUPERSEDED BY T-10 POINT 4 — this block used to read `event.update({ where:
  // { eventID } })`, which is the check-then-act T-10 exists to remove. The
  // status goes in the `where`.
  const applied = await ctx.db.event.updateMany({
    where: { eventID: input.eventID, status: "submitted" },
    data: {
      status: "draft",
      decidedAt: null, decidedBy: null, decisionReason: null,
      updatedAt: new Date(), updatedBy: userID,
    },
  });
  if (applied.count === 0) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_WITHDRAWABLE" });
  }

  await writeAudit(ctx.db, {
    actorUserID: userID, actorRoles: roles,
    targetCcaID: event.ccaID ?? undefined,          // T-8
    targetEventID: event.eventID,
    action: "event.withdraw",
    reason: event.title ?? undefined,
  });
  return { status: "draft" as const };
})
```

Notes the coder must not optimise away:

- **`identifiedProcedure`, not `roleManagerProcedure`.** This is a head's action over their
  own event. The authorisation is `loadOwnedEvent`, which covers both the CCA case and the
  hall case in one place (§5.4).
- **The status guard is `!== "submitted"`, not `editScope`.** Withdrawing is not editing.
  A `draft` is already withdrawn; a `published` event is cancelled, not withdrawn.
- **No booking cleanup.** A `submitted` event has no `bookingID` — the auto-book runs on
  approval (D-12), which by definition has not happened. Do not copy `cancelEvent`'s
  `bookings.deleteMany` block into this procedure; it would be dead code that looks
  load-bearing.
- **The queue removal is implicit.** `listForReview` filters `status: "submitted"`
  (`event.ts:793`); the status write is the removal. There is nothing else to update.

### 5.8 "Register and publish" — client-sequenced, no new procedure (D-27)

**There is no `event.registerAndPublish` procedure.** The hall surface calls the two
existing mutations back to back:

```ts
// EventManage.tsx, rendered ONLY when ccaID == null
async function registerAndPublish() {
  setError(null);
  try {
    await submit.mutateAsync({ eventID });                        // audits event.submit
  } catch (e) { setError(mapError(e)); return; }                  // stays draft
  try {
    await decide.mutateAsync({ eventID, decision: "approve" });   // audits event.approve
  } catch (e) {
    setError(publishStepError(e));   // §8.13 — the event is now `submitted`, not `draft`
  }
  await invalidate();
}
```

**Why two client calls and not one server procedure.** A fused procedure would have to
re-implement `decide`'s live `getUserRoles` + `computeCapabilities(roles).reviewEvents`
re-check (`event.ts:836-841`). That re-check is the guard that catches a role revoked
mid-session (I-5), and a second copy of it is a second thing to get wrong — the same
argument `ccaScope.ts:78-88` makes for not widening `assertHeadsCca`. Calling the real
procedures means the real guards run, unmodified.

**The two failure modes, both handled:**

| Step that fails | Resulting status | What the head sees |
|---|---|---|
| 1 (`submitForReview`) | stays `draft` | the normal `INCOMPLETE:` message (§8.5) — a missing banner, say |
| 2 (`decide`) | **`submitted`** | §8.13's message, which says plainly that it is now in the queue |

**Never roll back on a step-2 failure.** `submitted` is a legitimate state that any
reviewer — including the actor, on retry — can resolve. Rolling back to `draft` would
discard a real submission, and doing it automatically would mean a transient network error
silently un-submits an event. The half-state D-27 forbids is a *torn* state (published but
unaudited, or approved but not submitted); `submitted` is not that.

**`decide` is `roleManagerProcedure`**, so a CCA head calling it is refused regardless of
what the client renders. The button is gated on `ccaID == null` in the UI for clarity, not
for security.

### 5.9 `listForOwner` — the hall branch, and why the current filter hides hall events

`listMineForCca` (`event.ts:626-655`) is the **only** list a head-side surface has, and its
filter is `where: { ccaID: input.ccaID }` (`:635`). A null-ccaID row can never match a
number, so **without this change a hall event would be created and then be invisible
forever** — there is no other authoring list.

Grep-verified: that is the *only* Prisma `where` on `Event` keyed by `ccaID` in the whole
repo. Every other Event query filters on `status` or `eventID` and therefore already
includes null rows correctly: `listForReview` (`:793`), `listForOversight` (`:1053` — no
ccaID filter at all), `listPublished` (`:1152`), `listMySignups` (`:1315`). Nothing else
needs auditing for this.

`listForOwner` takes `{ ccaID: number | null }` and branches:

```ts
if (input.ccaID == null) {
  if (!computeCapabilities(roles).manageHallEvents) FORBIDDEN "CAPABILITY_REQUIRED:manageHallEvents";
} else {
  await assertHeadsCca(ctx.db, { userID, roles }, input.ccaID);
}
const events = await ctx.db.event.findMany({
  where: { ccaID: input.ccaID },   // null here matches STORED nulls — see T-12
  orderBy: { createdAt: "desc" },
});
```

The `where` clause is written unchanged because `input.ccaID` is already `number | null`
and Prisma renders `null` as a null match. **That is exactly why T-12 matters**: the match
finds stored nulls, not absent keys, so the writer must set the field explicitly.

`ccaIdInput` (`schemas/event.ts:311`) gains a nullable `ccaID` to match.

### 5.10 `attachCcaNames` and the "Hall" label

`attachCcaNames(db, ccaIDs: number[])` (`event.ts:213-225`) keeps its signature. Callers
stop passing nulls into it and resolve the display name through **one** new exported helper
in `src/lib/schemas/event.ts` (client-safe, so the UI can use it too):

```ts
/** The owner label for an event. null ccaID = a hall-wide, JCRC-owned event. */
export const HALL_OWNER_LABEL = "Hall";
export function ownerLabel(
  ccaID: number | null,
  ccaName: string | null,
): string {
  if (ccaID == null) return HALL_OWNER_LABEL;
  return ccaName ?? `CCA #${ccaID}`;
}
```

Every server projection that today does `ccaName: names.get(e.ccaID) ?? null` returns
`ccaName: e.ccaID == null ? HALL_OWNER_LABEL : (names.get(e.ccaID) ?? null)` **and** keeps
returning `ccaID`, so the client can still call `ownerLabel` itself. Callers to change:
`:804`, `:826`, `:1082`, `:1135`, `:1143`, `:1178`, `:1221`, `:1331`. The array built for
`attachCcaNames` filters nulls first:
`events.map(e => e.ccaID).filter((c): c is number => c != null)`.

---

## 6. File-by-file change list

**30 files touched: 5 created, 23 modified, 2 deleted.** (`JcrcRosterPanel.tsx` is the
23rd modified file: its JCRC grant-consent copy described the old proposal review and now
names the `manageHallEvents` power too — see §8.16.) The post-adjudication additions
(`withdraw`, "Register and publish", the withdrawn-review panel) all land inside files
already on this list — `routers/event.ts`, `services/roles.ts`, `lib/schemas/event.ts`,
`EventManage.tsx`, `EventsListPanel.tsx`, `EventReviewDetail.tsx` — so the count is
unchanged.

The two deletions are `EventFileField.tsx` (the proposal-PDF slot, D-1) and
`EventProposalFields.tsx` — the latter is a **rename** to `EventDetailsFields.tsx`, counted
as one delete plus one create so `git mv` shows up honestly in the diff.

Three more files appear in the tables below marked **"No change"** — `services/events.ts`,
`EventAnalytics.tsx`, `EventAttendees.tsx`, plus `index-census.mjs` — and are listed so
that their absence from the diff is a deliberate, reviewable decision rather than an
oversight.

### 6.1 Schema and shared vocabulary (2 modified)

| File | Change |
|---|---|
| `prisma/schema.prisma` | §3. `Event` doc comment, `ccaID Int?`, delete `proposalUrl`, add 4 inert fields. `Bookings` **untouched**. |
| `src/lib/schemas/event.ts` | §4. Status vocabulary, `editScope`, upload kinds, merged input schemas, `decideInput`, `reviewerCancelInput`, `ownerLabel`/`HALL_OWNER_LABEL`. |

### 6.2 Server (4 modified)

| File | Change |
|---|---|
| `src/server/api/routers/event.ts` | §5. The bulk of the work. |
| `src/server/api/services/roles.ts` | Add `manageHallEvents: boolean` to `Capabilities` (near `reviewEvents`, `:1181`) with a doc comment stating scrc's exclusion; add `manageHallEvents: manager,` in `computeCapabilities` (after `:1303`); edit `AUDIT_ACTIONS` `:231-235` per D-22 and rewrite the block comment at `:227-230`. |
| `src/server/api/services/events.ts` | **No change.** Listed so its absence is deliberate. |
| `src/server/api/services/ccaScope.ts` | **No change.** `assertHeadsCca` stays `ccaID: number`; the null branch lives in `loadOwnedEvent`, not here. Update the comment at `:84` which names `event.publish` (a procedure that no longer exists) → `event.update / cancelEvent / exportAttendees`. |
| `src/app/api/event/upload/route.ts` | The `select: { ccaID: true }` at `:59` now yields `number \| null`; branch exactly as `loadOwnedEvent` does — hall event → `computeCapabilities(roles).manageHallEvents`, else `assertHeadsCca`. Roles are already read live at `:66`; keep that. Update the docblock at `:15` which says "proposal PDF, banner, gallery photos". |

### 6.3 CCA head surface (5 modified, 1 deleted)

| File | Change |
|---|---|
| `EventCreateForm.tsx` (106) | Props `{ ccaID: number \| null; backHref: string }`. `createDraft`→`create`; `createDraftInput`→`createEventInput`; omit `ccaID` when null. Primary button **"Continue"** (D-14, §8.2). Delete the "Save the draft first…" note at `:83-86` and replace per §8.2. Redirect target comes from a new `manageHref(eventID)` prop rather than the hardcoded `/cca/${ccaID}/...` at `:29`. |
| `EventProposalFields.tsx` (203) | Rename to reflect it is no longer "proposal" fields — **`EventDetailsFields.tsx`**. Rewrite the description helper at `:101-104` and the facility note at `:177-180` (§8.3) — the latter currently says a booking is made "once JCRC approves", which is still true but the surrounding flow changed. No structural change; `facilityPayload`/`isFacilitySelected`/`EMPTY_PROPOSAL` keep working. |
| `EventManage.tsx` (603) | Largest UI edit. Props → `{ ccaID: number \| null; eventID: number; backHref: string }`. `ProposalEditor` → **`DetailsEditor`**: drop `EventFileField`, add `EventImageField` (banner) + `EventGalleryField` + the public-description textarea, so one editor collects everything (D-3). `PublicEditor` shrinks to the `published` case only. Delete `publish` mutation (`:205`) and every `mode === "publish"` branch. Status branches at `:514/:532/:547/:588` rewritten against the new vocabulary and driven by `editScope`, **imported** (§0.3). `CancelEventButton` stays; its confirm copy changes (§8.9). `AutoBookingNotice` stays as-is. `mapError` gains the new codes (§8.10). All three `listMineForCca.invalidate({ ccaID: event.ccaID })` at `:100/:219/:348` → `listForOwner.invalidate({ ccaID: event.ccaID })` (now nullable). `FIELD_LABELS` `:32-41` loses `proposalUrl`, gains nothing. **NEW — `WithdrawButton`** (D-26): rendered only for `status === "submitted"`, calls `event.withdraw`, confirm copy §8.12. **NEW — `RegisterAndPublishButton`** (D-27): rendered only when `ccaID == null && editScope === "all"`, runs `submitForReview` then `decide(approve)` per §5.8, confirm copy §8.13, failure copy §8.13. On the hall surface it **replaces** "Submit for review"; the two are never both shown. **The `submitted` branch renders a read-only panel, NOT an editor** (ruling C-2) — if the coder leaves `DetailsEditor` mounted for `submitted`, the server refuses every save with `EVENT_LOCKED` and the head gets a form that silently cannot save. |
| `EventsListPanel.tsx` (111) | Props `{ ccaID: number \| null; newHref: string; manageHref: (id:number)=>string }`. `listMineForCca`→`listForOwner`. The `"rejected"` branch at `:90` splits into `changes_requested` (amber, actionable) and `declined` (grey, terminal). Empty state and CTA copy per §8.2. Add the **"Finish and submit"** affordance for `draft` rows (D-14). A `submitted` row is **not** actionable from the list — it links to the manage page, where Withdraw lives. |
| `EventFileField.tsx` (123) | **DELETE.** The proposal-PDF slot. Nothing else imports it once `EventManage` drops it. |
| `EventImageField.tsx` (132), `EventGalleryField.tsx` (126) | No logic change; both already scope their uploads by kind (`"banner"` `:45`, `"photo"`). `EventImageField`'s `help` prop text is supplied by `EventManage` (§8.3). |
| `EventAnalytics.tsx` (114), `EventAttendees.tsx` (132) | **No change.** D-13. |

### 6.4 CCA routes (3 modified)

| File | Change |
|---|---|
| `src/app/cca/[ccaID]/events/page.tsx` (19) | Pass `newHref`/`manageHref` to `EventsListPanel`. |
| `src/app/cca/[ccaID]/events/new/page.tsx` (20) | Pass `backHref`/`manageHref` to `EventCreateForm`. |
| `src/app/cca/[ccaID]/events/[eventID]/page.tsx` (21) | Pass `backHref` to `EventManage`. |
| `src/app/cca/_components/CcaDashboardShell.tsx:32` | No change — the `"Events"` tab stays. |

### 6.5 Admin / JCRC surface (3 created, 4 modified)

| File | Change |
|---|---|
| `src/app/admin/events/layout.tsx` (36) | `:33` gate → `reviewEvents \|\| manageHallEvents` (D-20). |
| `src/app/admin/events/page.tsx` (5) | Render `EventReviewQueue` **and** a new `HallEventsPanel`. |
| `src/app/admin/_components/events/HallEventsPanel.tsx` | **CREATE.** Thin wrapper: `<EventsListPanel ccaID={null} newHref="/admin/events/hall/new" manageHref={id => \`/admin/events/hall/${id}\`} />` plus the section heading from §8.11. |
| `src/app/admin/events/hall/new/page.tsx` | **CREATE.** Renders `EventCreateForm` with `ccaID={null}`. |
| `src/app/admin/events/hall/[eventID]/page.tsx` | **CREATE.** Renders `EventManage` with `ccaID={null}`, `backHref="/admin/events"`. Parse the id the same way `src/app/events/[eventID]/page.tsx` does. |
| `EventReviewQueue.tsx` (80) | `:68` → `ownerLabel(e.ccaID, e.ccaName)` (§7). Empty-state copy §8.11. |
| `EventReviewDetail.tsx` (205) | `:90` → `ownerLabel(...)`. Delete the `proposalUrl` block `:119-128`. Two buttons become three: **Approve & publish**, **Request changes**, **Decline** (§8.4). Reason field becomes required for the latter two; helper text §8.4. `:146-150`'s "Approving will automatically book …" copy updated (§8.4) — it currently omits that approval also publishes. `:134-140`'s already-decided panel handles four terminal-ish states now. **NEW — the withdrawn panel** (T-10): when the fetched status is **not** `submitted` and **not** a decided state — i.e. the head withdrew it to `draft` — render §8.11's "This event was withdrawn" panel instead of the decision form. Must not render `NO_SUCH_EVENT`: the event exists. Also add the reviewer **Cancel** control for published events (`event.reviewerCancel`, T8) with the confirm copy from §8.9. |
| `src/app/admin/_components/AdminShell.tsx:59-64` | `requires: "reviewEvents"` → keep. The Hall panel lives inside a tab both capabilities already reach. |

### 6.6 Resident surface (2 modified)

| File | Change |
|---|---|
| `src/app/events/_components/EventsTimeline.tsx` (216) | `:189-191` — replace `{e.ccaName && ...}` with an unconditional `ownerLabel(e.ccaID, e.ccaName)`. **This is a silent-blank site (T-4).** |
| `src/app/events/_components/EventDetail.tsx` (226) | `:113-114` — same. Also a silent-blank site. |
| `src/app/events/page.tsx`, `[eventID]/page.tsx` | No change. |

### 6.7 SCRC surface (1 modified)

| File | Change |
|---|---|
| `EventsOversightPanel.tsx` (364) | `:146` and `:338` → `ownerLabel(...)`. The status `Select` at `:271-275` re-renders from the new `EVENT_STATUSES`, no code change. `:201-204`'s read-only note names "publishing" as a separate act — reword per §8.14. `:288-291`'s draft-filter caveat stays true and stays. |

### 6.8 Shared display (1 modified)

| File | Change |
|---|---|
| `src/app/events/_lib/format.ts` (139) | `STATUS_META` `:93-103` is `Record<EventStatus, …>` — **exhaustive**, so the vocabulary change is a `tsc` error here, which is the intended behaviour. New map in §8.1. Everything else in the file is untouched. |

### 6.9 Copy that lives outside the flow (1 modified)

| File | Change |
|---|---|
| `src/app/whats-new/page.tsx` | Four claims become false or misleading: `:231`, `:271`, `:272`, `:292`, `:379`. Replacements in §8.15. This is the file the repo's four copy-drift incidents were about — do not skip it. |

### 6.10 Scripts (1 created, 1 modified)

| File | Change |
|---|---|
| `scripts/remediation/verify-events-schema.mjs` | **CREATE.** §10. |
| `scripts/remediation/index-census.mjs` | **No code change.** Its `EXPECTED` list (`:107-128`) already contains `Event`, `EventSignup`, `EventLock`. Listed so the coder confirms rather than assumes. |
| `scripts/remediation/set-events-flag.mjs` | **No change.** Its header at `:16-17` tells the operator to `prisma db push` first; per C-1 that instruction is now wrong for *this* change. Add one sentence: see §9.5. |

---

## 7. The "Hall" display census (D-10)

Verified by grep on 2026-08-26, not inferred. Three classes, and the class matters more
than the count: **class A fails the build, class B renders garbage, class C renders
nothing.** Class C is the one that ships broken.

### 7.1 Class A — `tsc` catches these (18 sites)

`Event.ccaID` becomes `number | null`, so every one of these is a compile error until
fixed. They are listed so the coder can predict the error list, not because they need
hunting.

| # | Site | What breaks |
|---|---|---|
| A1 | `event.ts:90` | `assertHeadsCca(..., event.ccaID)` expects `number` → §5.4 |
| A2 | `event.ts:187` | `toPublicCard`'s param type `ccaID: number` → `number \| null` |
| A3 | `event.ts:561` | `targetCcaID: event.ccaID` (`publish`, being deleted) |
| A4 | `event.ts:616` | `targetCcaID: event.ccaID` (`cancelEvent`) → `?? undefined` |
| A5 | `event.ts:780` | `targetCcaID: event.ccaID` (`exportAttendees`) → `?? undefined` |
| A6 | `event.ts:798` | `events.map(e => e.ccaID)` into `attachCcaNames(number[])` → filter nulls |
| A7 | `event.ts:804` | `names.get(e.ccaID)` |
| A8 | `event.ts:823` | `attachCcaNames(ctx.db, [event.ccaID])` |
| A9 | `event.ts:826` | `names.get(event.ccaID)` |
| A10 | `event.ts:901` | **`ccaID: event.ccaID` in `bookings.create`** → `?? 0`. **T-1.** |
| A11 | `event.ts:949` | `targetCcaID: event.ccaID` (`decide`) → `?? undefined` |
| A12 | `event.ts:1076`, `:1082` | oversight list map + `names.get` |
| A13 | `event.ts:1131`, `:1135`, `:1143` | oversight detail |
| A14 | `event.ts:1158`, `:1178` | `listPublished` |
| A15 | `event.ts:1201`, `:1221` | `getPublic` |
| A16 | `event.ts:1321`, `:1331` | `listMySignups` |
| A17 | `upload/route.ts:70` | `assertHeadsCca(..., event.ccaID)` |
| A18 | `EventManage.tsx:100`, `:219`, `:348`, `:440` | `invalidate({ ccaID })` + the `ccaID: number` prop |

Plus `EventsListPanel.tsx:15` (`ccaID: number` prop) and `SCRC_HIDDEN_EVENT_FIELDS`
(`event.ts:275`, `proposalUrl: null` vs `satisfies Partial<Record<keyof Event, null>>`).

### 7.2 Class B — renders literal garbage (4 sites)

These compile. `ccaName` is null for a hall event (there is no `CCA` row to name), so the
`??` fallback fires and the user sees **`CCA #null`**.

| # | Site | Current code | Fix |
|---|---|---|---|
| B1 | `EventReviewQueue.tsx:68` | `` {e.ccaName ?? `CCA #${e.ccaID}`} `` | `{ownerLabel(e.ccaID, e.ccaName)}` |
| B2 | `EventReviewDetail.tsx:90` | `` {ccaName ?? `CCA #${event.ccaID}`} `` | `{ownerLabel(event.ccaID, ccaName)}` |
| B3 | `EventsOversightPanel.tsx:146` | `` {ccaName ?? `CCA #${event.ccaID}`} `` | `{ownerLabel(event.ccaID, ccaName)}` |
| B4 | `EventsOversightPanel.tsx:338` | `` {e.ccaName ?? `CCA #${e.ccaID}`} `` | `{ownerLabel(e.ccaID, e.ccaName)}` |

### 7.3 Class C — renders NOTHING, silently (2 sites)

**These are the dangerous ones.** They compile, they throw nothing, and the owner line
simply vanishes from the resident-facing pages — the two highest-traffic surfaces in the
feature. A hall event would appear on the timeline with no attribution at all and nobody
would file a bug, they would just not know who is running it.

| # | Site | Current code |
|---|---|---|
| C1 | `EventsTimeline.tsx:189-191` | `{e.ccaName && (<span …>{e.ccaName}</span>)}` |
| C2 | `EventDetail.tsx:113-114` | `{e.ccaName && (<p …>{e.ccaName}</p>)}` |

Fix both to render `ownerLabel(e.ccaID, e.ccaName)` unconditionally. The guard existed
because `ccaName` could be null for a *deleted* CCA; `ownerLabel` covers that case too
(`CCA #{id}`), so the guard is not merely relocated, it is retired.

### 7.4 Sites that are NOT "Hall" sites

Recorded so the coder does not go looking:

- `src/app/admin/_components/audit/AuditLogTable.tsx:81-82` — renders neither `targetCcaID`
  nor `targetEventID`. Every event audit row already shows `—`, so a null `ccaID` changes
  nothing. **Ruled out of the census and out of scope (C-4).** Recorded in §13 as something
  Phase 2 inherits. Do not add it to §7 and do not "fix" the Target column in this change.
- `src/app/_components/header.tsx:90`, `AdminShell.tsx:59`, `CcaDashboardShell.tsx:32`,
  `scrc/page.tsx:45` — nav labels only, no event data.
- `EventAnalytics.tsx`, `EventAttendees.tsx` — never read `ccaID`.

---

## 8. Verbatim copy

**Every string below is final. Do not paraphrase, do not "improve", do not invent one that
is missing — ask instead.** This repo has had four incidents of copy drifting out of sync
with behaviour; §8.4 and §8.9 are the two that enumerate consequences and they were written
against §2's transition table, line by line.

Typography note: the existing files use curly quotes (`’`, `“”`) and en/em dashes. Match
them — `EventManage.tsx:596` uses `’`, `EventReviewDetail.tsx:148` uses `’`.

### 8.1 Status labels and the owner label

`src/app/events/_lib/format.ts` — replaces `:93-103`:

```ts
export const STATUS_META: Record<
  EventStatus,
  { label: string; className: string }
> = {
  draft:              { label: "Not submitted",   className: "bg-gray-100 text-gray-700" },
  submitted:          { label: "In review",       className: "bg-amber-100 text-amber-800" },
  changes_requested:  { label: "Changes needed",  className: "bg-orange-100 text-orange-800" },
  published:          { label: "Published",       className: "bg-emerald-100 text-emerald-800" },
  declined:           { label: "Declined",        className: "bg-red-100 text-red-700" },
  canceled:           { label: "Cancelled",       className: "bg-gray-200 text-gray-500" },
};
```

Two notes the coder must not "fix":
- The **status key** is `canceled` (one `l`) and the **label** is `"Cancelled"` (two).
  The key matches `EVENT_STATUSES` and the existing DB convention (`event.ts:1013`
  says so explicitly); the label matches the rest of the UI's British spelling
  (`EventManage.tsx:384` "Cancelling…", `:593` "This event was cancelled.").
- `draft`'s label is **"Not submitted"**, not "Draft" (D-14).

The owner label:

```
Hall
```

Exactly that — capital H, no suffix. Not "Hall-wide", not "Raffles Hall", not "JCRC".
`HALL_OWNER_LABEL` in `src/lib/schemas/event.ts` is its single definition (§5.10).

### 8.2 Create form and the list panel

`EventCreateForm.tsx` — replaces the note at `:83-86`:

> Fill in what you know now. You'll add the banner and the description residents see on the next screen, then submit it for review.

Primary button (`:93`), replacing `"Save draft"` / `"Saving…"`:

> Continue

> Saving…

Secondary button (`:102`) unchanged: `Cancel`

`EventsListPanel.tsx` — empty state, replacing `:58-63`:

> Nothing here yet

> Add your event's details, a banner and a description, and JCRC will review it.

CTA button (`:50`), unchanged: `New event`

Draft-row affordance (D-14), new:

> Finish and submit

Header line (`:44`), unchanged: `No events yet.`

Status line for a `changes_requested` row, replacing `:92`:

> JCRC asked for changes: {reason}

Status line for a `declined` row, new:

> JCRC declined this: {reason}

### 8.3 The details form

`EventDetailsFields.tsx` (was `EventProposalFields.tsx`) — replaces `:101-104`:

> What the event is, who it's for, and what happens. JCRC reads this when they review it.

Textarea placeholder (`:112`), replacing `"Tell JCRC about your event…"`:

> Tell JCRC about your event…

*(unchanged — it is still accurate)*

Facility note, replacing `:177-180`:

> If JCRC approves, this facility is booked automatically for the times above — so set an end time.

Capacity note (`:196-198`), unchanged:

> Blank means no cap. Signups close automatically when full.

Banner field help, passed from `EventManage` to `EventImageField` (replaces `:270`):

> The wide image residents see first. Required before you can submit.

Public description label and help, in the merged editor (replaces `:293-296`):

> What residents read on the event page. Required before you can submit.

### 8.4 The reviewer's three decisions

`EventReviewDetail.tsx`. Buttons, replacing `"Approve"` (`:181`) and `"Reject"` (`:198`):

> Approve & publish

> Request changes

> Decline

The consequence line above the buttons — **this string enumerates what the code does and
was written against §2 T4**. Replaces `:146-150`. Two variants, because the booking half
only applies when a facility was chosen:

*When `event.facilityID != null`:*

> Approving publishes this event to the residents' timeline straight away and books {location} for its times. If the room is already taken, the event still publishes and the CCA head is told to book it themselves.

*When `event.facilityID == null`:*

> Approving publishes this event to the residents' timeline straight away.

Reason field label, replacing `:152-155`:

> Reason

> (required to request changes or decline)

Placeholder (`:162`), replacing `"Feedback for the CCA head…"`:

> What needs to change, or why this can't go ahead…

Helper under the two non-approve buttons, new:

> Request changes sends it back so they can edit and resubmit. Decline is final — the event cannot be resubmitted.

Already-decided panel, replacing `:134-140`. Per status:

| Status | Line |
|---|---|
| `published` | This event was approved and is live on the residents' timeline. |
| `changes_requested` | Changes were requested. The CCA head can edit and resubmit it. |
| `declined` | This event was declined. It cannot be resubmitted. |
| `canceled` | This event was cancelled. |

Followed, when `decisionReason` is set, by (unchanged shape, `:138-140`):

> Reason: {decisionReason}

Stale-decision error (`:36`), unchanged:

> This event has already been decided. Reload the page.

Missing-reason error, replacing `:38`:

> A reason is required to request changes or decline.

### 8.5 Completeness message

`EventManage.tsx` `FIELD_LABELS`, replacing `:32-41` (note: `proposalUrl` is gone,
`endTime` and the two public fields stay):

```ts
const FIELD_LABELS: Record<string, string> = {
  title: "event name",
  description: "description",
  startTime: "start time",
  endTime: "end time",
  location: "location",
  banner: "banner image",
  publicDescription: "public description",
};
```

The assembled message (`:49`), unchanged:

> Please add: {a, b and c}.

### 8.6 Head-facing status panels

`EventManage.tsx`. `submitted` panel, replacing `:521-527`. **The form is read-only in this
state** (ruling C-2) — the panel replaces the editor, it does not sit above it:

> Submitted — waiting for JCRC review.

> You can't edit it while it's in the queue. Need to change something? Withdraw it, edit, and submit again.

Alongside that panel, the **Withdraw** button (§8.12).

**Do not write copy here that implies the event is editable.** The previous draft of this
plan carried "You can still edit it while you wait" and that sentence is now false; it is
called out because a stale copy string surviving a behaviour change is the exact
four-incident failure mode §8 exists to prevent.

`changes_requested` panel, replacing the `rejected` panel at `:132-139`:

> JCRC asked for changes

> {decisionReason}

> Edit below and submit again.

`declined` panel, new:

> JCRC declined this event.

> {decisionReason}

> Declined events can't be resubmitted. You can duplicate it and start a fresh one.

`published` — the `approved` panel at `:534-537` is **deleted** (there is no `approved`).
The published surface keeps its existing sections: `Signups` (`:552`), `Attendees`
(`:559`), `Event details` (`:567`), and `Close` / `Edit details` (`:575`) — all unchanged.

New line above the published editor, explaining the narrowed edit scope (T9/T10 in §2.1):

> This event is live. You can still change the banner, photos and public description — the date, location and capacity are fixed now.

`canceled` panel (`:592-597`), unchanged:

> This event was cancelled.

> It no longer appears on the residents' timeline.

Submit button in the details editor, replacing `:171-175`:

> Save and finish later

> Submit for review

> Submitting…

### 8.7 Duplicate

Button, new:

> Duplicate

Confirmation, new — **this string enumerates what D-19 actually does**:

> Duplicate this event?

> You'll get a new unsubmitted copy with the same details, times and location. The banner and photos aren't copied — add them again before you submit.

> Cancel

> Duplicate

Title suffix applied by `event.duplicate` server-side:

> {original title} (copy)

When the original has no title, the copy has no title either — do not synthesise one; the
list already renders `Untitled event` (`EventsListPanel.tsx:78`).

Success toast / redirect: no toast. Redirect straight to the new event's manage page, the
same interaction shape as `create` (D-14).

### 8.8 Validation messages (`src/lib/schemas/event.ts`)

`decideInput` superRefine, replacing `:304`:

> A reason is required to request changes or decline

Unchanged: `"Title is required"` (`:66`), `"Description is required"` (`:67`),
`"Location is required"` (`:68`), `"End time must be after the start time"` (`:191`),
`"NOT_A_VALID_EVENT_BLOB_URL"` (`:245`, `:275`, `:284` — machine codes, not copy).

### 8.9 Cancel confirmations

Head, `EventManage.tsx` `CancelEventButton`. Trigger (`:361`), unchanged: `Cancel event`

Confirmation, replacing the bare `"Cancel this event?"` at `:367`. **Two variants, because
the consequences genuinely differ** — this is precisely the class of string that has drifted
before:

*When `status === "published"`:*

> Cancel this event?

> It comes off the residents' timeline, everyone who signed up loses their place, and the facility booking is released. This can't be undone.

*When `status` is `draft` / `submitted` / `changes_requested`:*

> Cancel this event?

> It won't go ahead and can't be resubmitted. This can't be undone.

Buttons (`:375`, `:384`), unchanged: `No` / `Yes, cancel` / `Cancelling…`

Reviewer, `EventReviewDetail.tsx`, new:

> Cancel this published event?

> It comes off the residents' timeline, everyone who signed up loses their place, and the facility booking is released. The CCA head is not asked first. This can't be undone.

> Reason (required)

> Keep it live

> Cancel the event

**Accuracy check on the above, done against the code so it stays true:** "loses their
place" — `EventSignup` rows are *not* deleted by cancel (`event.ts:584-592` only updates
the event and deletes the booking), but the event leaves `listPublished`
(`where: { status: "published" }`, `:1152`) and `listMySignups`
(`:1315`), so the signup becomes unreachable and inert. "Loses their place" is the honest
description of the user-visible outcome. Do **not** change the copy to promise deletion,
and do **not** add a deletion to match the copy — the rows are the record that people had
signed up, and `exportAttendees` still needs them.

### 8.10 Error mapping

`EventManage.tsx` `mapError`, replacing `:422-434`. Keep every existing branch except
`NOT_APPROVED` (that error no longer exists), and add the rest:

| Code | Message |
|---|---|
| `END_BEFORE_START` | The end time must be after the start time. *(unchanged)* |
| `NOT_A_HEAD_OF_THIS_CCA` | You're no longer a head of this CCA. *(unchanged)* |
| `EVENTS_DISABLED` | Events aren't switched on yet. *(unchanged)* |
| `CAPABILITY_REQUIRED:manageHallEvents` | You can't manage hall events. |
| `CAPABILITY_REQUIRED:reviewEvents` | You can't review events. |
| `EVENT_LOCKED` | This event is in the review queue. Withdraw it first to make changes. |
| `NOT_SUBMITTABLE` | This event can't be submitted from its current state — it's already in the queue, or it's been decided. Reload the page. |
| `NOT_WITHDRAWABLE` | This event isn't in the review queue. Reload the page. |
| `NOT_UNDER_REVIEW` | Someone has already decided this event. Reload the page. |
| `NOT_CANCELABLE` | This event is already declined or cancelled, so there's nothing to cancel. Reload the page. |
| `NO_SUCH_EVENT` | This event no longer exists. *(already at `:460`)* |
| *(fallback)* | That didn't save. Try again. *(unchanged)* |

**`NOT_SUBMITTABLE` was missing from this table too, and the second review pass
had to add it.** It is the identical defect to `NOT_CANCELABLE` below, in the
identical procedure family, and it survived the pass that fixed `NOT_CANCELABLE`.
`submitForReview` throws it whenever `editScope` is not `"all"` — a second tab
that submitted first, or a reviewer declining a `changes_requested` event while
its editor is open. Retrying can never succeed from any of the three refusing
states: `submitted` needs a withdraw, and `declined` and `canceled` are terminal.
The test for whether a code belongs in this table is not "is it common" but
**"can retrying ever work?"** — if not, the fallback is lying.

**`NOT_CANCELABLE` was missing from this table and had to be added during
review.** `cancelEvent` throws it whenever the row is already `declined` or
`canceled` (§5, `cancelEvent`), and `reviewerCancel` throws it for anything that
is not `published`. Both are races a user loses in normal operation — a second
tab, the owning head and the JCRC cancelling at the same moment — so the code
falls through to a fallback that says **"Try again."** about an action that can
*never* succeed, because both refusing states are terminal. A fallback string is
acceptable for an error nobody hits; it is a defect for one two roles can hit
concurrently.

The **reviewer's** side of the same error needs its own wording, because that
panel has no `mapError` — see §8.11.

Note also that `CancelEventButton` must RENDER an error at all: it originally
had no `onError` and no error state, so a refused cancel did nothing visible
whatsoever. A destructive control that fails silently reads as a broken app and
leaves the owner believing the event is cancelled.

**`EVENT_LOCKED`'s message is deliberately actionable.** The generic "can't be edited any
more" would be a lie for a `submitted` event, which *can* be edited — after a withdraw. The
same code is thrown for `declined` and `canceled`, where withdrawal is impossible, so the
UI must not render this string for those two: they show the terminal panels from §8.6 and
never expose an editor at all, so the error is unreachable there in practice.

`INCOMPLETE:` is handled by `incompleteMessage` (`:43-50`) — unchanged.

### 8.11 Admin surface

`EventReviewQueue.tsx`. Heading (`:37`), unchanged: `Event review`
Empty state (`:48-53`), unchanged:

> The queue is empty

> Submitted events appear here for approval.

**Withdrawn out from under the reviewer.** When a head withdraws an event the JCRC has open
(T-10), the queue row disappears on the next fetch and `getForReview` starts returning a
non-`submitted` record. `EventReviewDetail` must render this, not a stale decision form:

> This event was withdrawn

> The CCA head pulled it back to make changes. It'll return to the queue when they resubmit it.

**…for a CCA event. A hall-wide event needs the other sentence** (corrected
during review):

> The JCRC pulled it back to make changes. It'll return to the queue when it's resubmitted.

The frozen string named a CCA head, and a hall-wide event (`ccaID == null`) has
none — nobody heads it, and whoever withdrew it holds `manageHallEvents`, quite
possibly the reviewer reading the line. This document froze the string before
D-20 put hall events on the same review surface, so the two rulings disagree and
the *truth* wins: **a frozen string is not more authoritative than what the code
does.** `EventReviewDetail` already has `event.ccaID` in hand, so the branch is
one ternary. The same correction applies to the already-decided line for
`changes_requested`, which likewise said "The CCA head can edit and resubmit
it"; for a hall event it reads "The JCRC can edit and resubmit it."

**And the reviewer-cancel panel needs an error map** (also added during review).
`reviewerCancel` refuses anything that is not `published` with `NOT_CANCELABLE`,
which is precisely what a reviewer gets when the owning head — or a second JCRC
— cancels first. The panel had a single unconditional `onError` string:

> ~~That didn't go through. Try again.~~

Retrying can never succeed; the event is already terminal. It becomes:

| Code | Message |
|---|---|
| `NOT_CANCELABLE` | This event is no longer live — someone else has already cancelled it. Reload the page. |
| `NO_SUCH_EVENT` | This event no longer exists. |
| `CAPABILITY_REQUIRED:reviewEvents` | You can't review events. |
| `EVENTS_DISABLED` | Events aren't switched on yet. |
| *(fallback)* | That didn't go through. Try again. |

> ← Back to the queue

And if the reviewer had already typed a reason and pressed a decision button before the
refetch landed, `decide` fails its `NOT_UNDER_REVIEW` guard and they get (§8.4, unchanged):

> This event has already been decided. Reload the page.

That string is accurate enough for the withdraw case too — the event is no longer decidable
— but if the coder prefers precision, `EventReviewDetail` may branch on the fetched status
and show instead:

> This event was withdrawn while you were reviewing it. Nothing was saved.

`HallEventsPanel.tsx` heading, new (ruling D-27):

> Hall events

> Events the JCRC runs itself. You register and publish them here — they don't go through the review queue below.

That line is **true under D-27**: the "Register and publish" button runs `submitForReview`
and `decide(approve)` back to back, so the event never sits in the queue waiting for anyone.
It does still pass through `submitted` for a moment, and both calls are audited, so the
record shows exactly who did it (D-22).

### 8.12 Withdraw (D-26)

`EventManage.tsx`, rendered only when `status === "submitted"`. Trigger button, new:

> Withdraw

Confirmation dialog, new. **This string enumerates consequences and was written against
§2.1 T3a** — it must stay true if the transition changes:

> Withdraw this event from review?

> It comes out of the JCRC queue and goes back to being editable. Nothing is lost — submit it again when you're ready.

> Keep it in the queue

> Withdraw

Pending label: `Withdrawing…`

**Copy discipline for this dialog.** It must **not** say "cancel", must **not** imply the
event is deleted, and must **not** promise the JCRC is notified — nothing sends a
notification (§13). "Nothing is lost" is accurate: `withdraw` clears only the decision
fields, which are null on a `submitted` event anyway, and touches no content field (§5.7).

After a successful withdraw the head lands on the editable `draft` form with the badge
reading **"Not submitted"** (§8.1) — no toast, the state change is the feedback.

### 8.13 Register and publish — hall events only (D-27)

`EventManage.tsx`, rendered only when `ccaID == null` **and** `editScope === "all"`. It
replaces the "Submit for review" button on that surface; a hall event never shows both.

Button:

> Register and publish

Pending label: `Publishing…`

Confirmation dialog — **enumerates what the two calls actually do**:

> Register and publish this event?

> It goes live on the residents' timeline straight away. You're approving it yourself, and both steps are recorded in the audit log.

When a facility is selected, append to the second line:

> {location} is booked for its times.

Buttons:

> Not yet

> Register and publish

**Step-2 failure message** (`publishStepError`) — the event is now `submitted`, and the copy
must say so rather than implying nothing happened:

> Your event was registered but couldn't be published: {reason}

> It's sitting in the review queue now. Try publishing again, or leave it for another JCRC member to approve.

`{reason}` is the mapped message from §8.10 for the underlying error — most plausibly
`You can't review events.` (a role revoked mid-session, which is precisely the case D-27's
live re-check exists to catch) or the generic fallback.

**Step-1 failure** uses the ordinary `INCOMPLETE:` path (§8.5) with no special casing — a
hall event missing a banner reads `Please add: banner image.` exactly like a CCA event.

### 8.14 SCRC oversight

`EventsOversightPanel.tsx`, replacing `:201-204`:

> This is a read-only view. Approving, requesting changes, declining and cancelling stay with the JCRC and the CCA head.

`:288-291`'s draft-filter caveat stays **verbatim** — it is still true, and it describes a
raw-vs-normalised behaviour (`event.ts:1044-1051`) that this change does not touch.

`DisabledNotice.tsx:35-36` — unchanged.

### 8.15 `whats-new/page.tsx`

| Line | Now | Becomes |
|---|---|---|
| `:231` | **CCAs propose, JCRC approves.** Events go through a quick review so the hall calendar stays coordinated and nothing clashes. | **CCAs create, JCRC approves.** Fill in the whole event — details, banner, description — and JCRC reviews the finished thing. Approving puts it straight on the timeline. |
| `:232` | **Rooms book themselves.** Approve an event using a hall facility and the room is reserved automatically — no separate step, no double-bookings. | *(unchanged — still true)* |
| `:271` | **Approve events** proposed by CCAs, or send them back with feedback. | **Approve events** created by CCAs, send them back for changes, or decline them outright. |
| `:272` | **Rooms sorted automatically** when an event is approved — no chasing, no clashes. | *(unchanged)* |
| `:292` | **Put on events** and, once approved, publish them with photos and details. | **Put on events** — add the details, banner and photos, and it goes live the moment JCRC approves. |
| `:379` | CCAs propose, JCRC approves | CCAs create, JCRC approves |

---

## 9. Migration and rollout

> **RULING C-1 IS BINDING HERE. There is no `prisma db push` in Phase 1.**
> The whole database step is `npx prisma generate`. The index census runs **before and
> after** as verification, and `verify-events-schema.mjs` is a **read-only assertion**
> script that never creates or drops anything. The guarded push procedure survives only in
> **Appendix A**, marked *not to be run in Phase 1*.

The sequence: measure → census → `prisma generate` → typecheck/build → deploy → census
again → verify.

### 9.1 Pre-flight — re-measure the zero (BLOCKING)

Three of the decisions above are only valid while the collection is empty.

```bash
node scripts/remediation/verify-events-schema.mjs > events-before.txt
```

It must report `Event 0`, `EventSignup 0`, and `0` rows carrying `event.reject` or
`event.publish` (§10). **If any is non-zero, STOP.** D-1 (dropping a column), D-4
(deleting a status) and D-22 (retiring two audit actions) all become data migrations, and
this plan does not cover them.

### 9.2 Index census — before

```bash
node scripts/remediation/index-census.mjs > census-before.txt
```

Exit 0 required. A non-zero exit means `email_unique_ci` is already missing — restore it
with the one-liner in `index-census.mjs:76-78` before doing anything else.

### 9.3 The schema change — `prisma generate`, and nothing else

```bash
# Edit prisma/schema.prisma per §3, then:
npx prisma generate
```

**That is the entire database step.** No `db push`. No `migrate`. No `createIndexes`.

Why this is sufficient, restated so nobody re-litigates it at the terminal:

| What §3 does | Server-side effect on Mongo |
|---|---|
| drop `Event.proposalUrl` | none — Prisma's schema is a client-side type assertion |
| `Event.ccaID Int` → `Int?` | none — same reason |
| add 4 nullable/defaulted fields | none — Mongo is schemaless; the fields appear when written |
| index changes | **there are none** (§3.5) |

§0.6 measured every unique index this change depends on and found all of them present.
`prisma generate` rewrites the client types, which is what turns §7.1's 18 sites into
compile errors — the mechanism the whole plan relies on.

**If you find yourself about to type `prisma db push`, stop and read Appendix A.**

### 9.4 Verification, not migration

There is no migration step, so this slot is a second **assertion** instead:

```bash
node scripts/remediation/verify-events-schema.mjs     # exit 0 required
```

Run it after `prisma generate` and again after deploy (§9.7). It is read-only — it asserts
the six unique indexes exist and refuses to run with `--commit` (§10). It fixes nothing; if
it fails, the remedy is Appendix A's restore one-liner, executed deliberately by a human.

### 9.5 One-line edit to `set-events-flag.mjs`

Its header (`:16-17`) used to read *"Run `npx prisma db push` FIRST"*.

**REVISED DURING REVIEW — the instruction is DELETED AND RETRACTED, not appended to.**
An operator skimming a header for the command to run will run the command the header
names; a qualifying note two paragraphs below it does not survive a skim. The header now
opens with `DO NOT RUN `prisma db push` BEFORE THIS SCRIPT.` and explains that the
collections and indexes already exist, that a push would drop `User.email_unique_ci`, and
that `prisma generate` is the whole database step. The appended-parenthetical text this
section originally specified appears nowhere in the repo, deliberately.

### 9.6 Deploy

The frontend is on **Vercel**, not the droplet. `npx prisma generate` runs in `postinstall`
(`package.json`), so the deployed client picks up the new schema automatically. The kill
switch is already `"on"`; nothing needs flipping.

### 9.7 Post-deploy verification

```bash
node scripts/remediation/index-census.mjs > census-after.txt
diff census-before.txt census-after.txt        # must be empty
node scripts/remediation/verify-events-schema.mjs
```

Then the manual pass in §11.2.

### 9.8 Rollback

Three independent levers, cheapest first.

1. **Kill switch — seconds, no deploy.**
   ```bash
   node scripts/remediation/set-events-flag.mjs off --commit
   ```
   `assertEventsEnabled` is the first line of all 22 procedures (`event.ts:296` and 21
   others) and of the upload route (`route.ts:44`), so the whole surface goes inert
   within the 15-second flag cache TTL (`services/events.ts:19`). This is the correct
   first move for any events-specific incident.

2. **Revert the deploy — minutes.** Vercel rollback to the previous deployment. The old
   client expects `proposalUrl` and a non-null `ccaID`. Because the collection is empty at
   cutover, the only rows that could exist are ones created *after* the deploy. If any
   hall-wide event (`ccaID: null`) was created, the reverted client's Prisma layer will
   **throw** on reading it (a required scalar is absent). Remedy before reverting:
   ```js
   db.Event.deleteMany({ ccaID: null })
   ```
   …or set them to a real ccaID. **`verify-events-schema.mjs` prints the null-ccaID count
   precisely so this decision can be made in one command.**

3. **Revert the schema.** `git revert` the `schema.prisma` change and `prisma generate`.
   No index was created, so nothing needs dropping. Note that `proposalUrl` cannot be
   "restored" with data — there never was any.

**There is no data-loss rollback risk**, because there is no data. That property expires
the moment a head creates the first real event, which is the intended outcome of this
work — so land the rollout and the verification in the same session.

---

## 10. `scripts/remediation/verify-events-schema.mjs`

**CREATE. READ-ONLY ASSERTION SCRIPT — ruling C-1.**

> **It asserts. It never repairs.** The script issues reads only: `listIndexes`, `find`,
> `count`. It **must not** call `createIndexes`, `dropIndex`, `createCollection`, any
> `update`/`insert`/`delete`, or `prisma db push`. If an index it requires is missing it
> **exits non-zero and says which one** — a human then runs the restore one-liner from
> Appendix A.3 deliberately. A verification script that silently fixes what it measures is
> not a verification script; it is an undocumented migration, and the next operator will
> trust a PASS that its own side effects produced.

No `--commit` flag; `isCommit()` is consulted **only to refuse**, the same discipline as
`verify-recruitment-gate.mjs:10-12` and `verify-user-admin-safety.mjs`. Model it on
`verify-recruitment-gate.mjs` — header docblock explaining what it can and cannot check,
numbered checks, `process.exitCode` (never `process.exit()`, so `.finally()` runs and
stdout flushes).

Imports from `./lib/rbac.mjs`: `isCommit`, `abort`, `countWhere`, `numify`. **Note what is
absent from that import list: nothing that writes.**

### Checks

| # | Check | Blocking? |
|---|---|---|
| **[1]** | **The unique indexes the locks and idempotency rest on exist.** For each of `Event.eventID`, `EventSignup.event_user`, `EventLock.key`, `Counter.key`, `Bookings.bookingID`, `BookingLock.key`: `listIndexes` and assert one index exists on that key with `unique: true`. Match on the **key pattern**, not the index name — `db push` and `createIndexes` produce different names (`EventLock_key_key` vs a hand-made `key_1`), and a name match would report a false failure. | **YES — exit 1** |
| **[2]** | **`User.email_unique_ci` exists, is unique, and carries `collation: { locale: "en", strength: 2 }`.** Not this feature's index, but it is the one `db push` drops and this script may be the only thing an operator runs. Assert the collation too — a unique index on `email` *without* it does not fold case and is not the guard. | **YES — exit 1** |
| **[3]** | **`Bookings.ccaID` has no null.** `countWhere(db, "Bookings", { ccaID: null })` must be `0`. This is the D-8 invariant made measurable: a null here means someone introduced a second "absent" value into a column that already has the `0` sentinel. Print the `ccaID: 0` count beside it (expected ~3,839 and rising) so the sentinel's population is visible rather than assumed. | **YES — exit 1** |
| **[4]** | **No `Event` carries `proposalUrl`.** `countWhere(db, "Event", { proposalUrl: { $exists: true } })` must be `0`. Catches a stale client writing a dropped field. | **YES — exit 1** |
| **[5]** | **Status vocabulary.** Distinct `Event.status` values ⊆ `{draft, submitted, published, changes_requested, declined, canceled, null}`. Anything else — notably a surviving `approved` or `rejected` — is a row `normalizeStatus` will silently read as `draft`. | **YES — exit 1** |
| **[6]** | **Pre-flight counts (informational, §9.1 reads these).** `Event` total, `Event` where `ccaID: null` (hall events — the number §9.8 lever 2 needs), `EventSignup` total, `EventLock` total (should be 0 at rest; a non-zero standing count means a leaked lock), and `RoleAuditLog` counts for `event.reject` and `event.publish` (must be 0 before D-22 retires them). Also print the counts for `event.submit`, `event.withdraw`, `event.approve`, `event.changes`, `event.decline` — after rollout these are the feature's heartbeat, and a hall event self-approval shows as an `event.submit` + `event.approve` pair with one actor (D-22). | no |
| **[7]** | **Counter sanity.** `Counter` row for key `"eventID"`: its `seq` must be `>= max(Event.eventID)`. A `seq` behind the max means `nextEventId` will collide on the `eventID` unique index. | **YES — exit 1** |

### Exit codes

Follow `verify-recruitment-gate.mjs` exactly:

- `0` — every blocking check passed.
- `1` — a blocking check failed. **The checks ran**; something is wrong with the data.
- `2` — nothing was measured: could not connect, an unexpected throw *before* any blocking
  failure was recorded, or the script was invoked with `--commit` / `APPLY=yes`. A `2` is
  **not** evidence the schema is healthy.

In the `.catch`, use `process.exitCode = failed > 0 ? 1 : 2` — a detected data failure
outranks a later connectivity blip, for the reason spelled out at
`verify-recruitment-gate.mjs`'s tail.

### What it cannot check, stated in the header

It is a plain Mongo script, not a Next request, so it cannot call tRPC and therefore
cannot exercise `loadOwnedEvent`, `editScope`, the status machine, or
`assertEventsEnabled`. It checks the **data and the indexes** those depend on. A PASS means
the substrate is sound; it says nothing about whether the router's transitions are correct.
That is §11's job.

---

## 11. Test plan

### 11.1 What the coder must run and pass before handing over

In order. Do not proceed past a failure.

```bash
npx prisma generate                 # must precede tsc — it writes the types
npx tsc --noEmit                    # ZERO errors
npm run lint                        # ZERO new warnings
npm run build                       # next build must succeed
node scripts/remediation/verify-events-schema.mjs     # exit 0
node scripts/remediation/index-census.mjs             # exit 0, diff clean vs before
```

**`tsc --noEmit` is the primary instrument for this change, not a formality.** §7.1
predicts 18+ error sites. The coder should expect them, fix each one deliberately, and
**re-read A10 (`event.ts:901`) before fixing it** — the mechanical fix (`ccaID: event.ccaID!`
or `?? null`) is wrong; the correct fix is `?? 0` (T-1).

A clean `tsc` is necessary and **not sufficient**. Three classes of error compile perfectly:

- §7.2's four `CCA #null` sites and §7.3's two silent-blank sites — fixed by reading §7,
  not by chasing errors.
- **`editScope("submitted")` returning `"all"` instead of `"none"`.** The signature is
  identical either way; the compiler cannot tell. Getting it wrong silently reinstates the
  moving-target bug ruling C-2 exists to remove, and every test in §11.2 C2 is what catches
  it. Read D-2's table.
- **A fused "register and publish" server procedure.** It would typecheck and work in the
  happy path while quietly dropping `decide`'s live capability re-check (D-27, T-11).

### 11.2 Manual verification — a human, in a browser, after deploy

Requires three accounts: a `cca_head` who is not jcrc, a `jcrc`, and a plain `resident`
with a matric on file. Run against the live app with `events.enabled = "on"`.

**A — CCA event, happy path**

1. As the head: `/cca/{ccaID}/events` → **New event**. Fill title, description, start, end,
   pick a **facility**, set capacity 2. Press **Continue**.
   *Expect:* lands on the manage page. Badge reads **"Not submitted"**. The word "Draft"
   appears nowhere. There is no proposal-PDF field anywhere on the page.
2. Upload a banner, type a public description. Press **Submit for review**.
   *Expect:* badge → **"In review"**. Panel reads "Submitted — waiting for JCRC review."
3. Try submitting a second event with **no banner**.
   *Expect:* `Please add: banner image, public description.` — not a generic failure.
4. As the jcrc: `/admin/events`. The event is in the queue, owner column shows the CCA name.
   Open it. *Expect:* three buttons — **Approve & publish**, **Request changes**, **Decline**.
   No proposal PDF link.
5. Press **Approve & publish**.
   *Expect:* status → **Published** in one step (there is no "Approved" state to pass
   through). As the resident, `/events` shows it immediately.
6. **Check the booking.** In the bookings calendar, the facility is booked for the event's
   times under the head's name. In the DB: `db.Event.findOne({eventID}).bookingID` is set,
   and the matching `Bookings` row carries **`ccaID: <the CCA's id>`**, not 0.

**B — the hall-wide event and the `ccaID: 0` trap (the most important test here)**

7. As the jcrc: `/admin/events` → **Hall events** → **New event**. Fill it in, pick a
   **facility**, then press **Register and publish** (D-27). Confirm the dialog text matches
   §8.13 verbatim.
   *Expect:* the event goes to **Published** in one interaction. It never appears in the
   review queue. Confirm the audit log holds **two** rows for it — `event.submit` then
   `event.approve` — with the **same** `actorUserID`, seconds apart (D-22).
7a. Confirm a CCA head's own event surface shows **Submit for review** and **never**
   **Register and publish**. Then, as a CCA head, call
   `event.decide({ eventID, decision: "approve" })` directly on their own submitted event.
   *Expect:* refused — `decide` is on `roleManagerProcedure`. The UI gate is for clarity;
   this is the real one.
7b. **Step-2 failure.** Hardest to stage; if it can be arranged (revoke the actor's `jcrc`
   between the two calls, or block the second request), confirm the event is left at
   **`submitted`** — in the queue, not rolled back to `draft` — and the head sees §8.13's
   "Your event was registered but couldn't be published…" message. **A rollback to `draft`
   here is a bug** (D-27, T-11).
8. **Verify the booking row.** This is the one that has to be right:
   ```js
   db.Event.findOne({ eventID: <id> })     // ccaID must be null
   db.Bookings.findOne({ bookingID: <that event's bookingID> })
   ```
   *Expect:* `Bookings.ccaID === 0`. **Not `null`, not absent.** If it is null or absent,
   stop and re-read D-8 — the sentinel invariant is broken and check [3] of
   `verify-events-schema.mjs` will now fail forever.
9. **Every "Hall" site.** Confirm the literal string `Hall` renders — and that
   `CCA #null` renders **nowhere** — on all six of:
   - `/events` timeline card *(§7.3 C1 — silently blank if missed)*
   - `/events/{id}` detail *(§7.3 C2 — silently blank if missed)*
   - `/admin/events` review queue row *(B1)*
   - `/admin/events/{id}` review detail *(B2)*
   - `/scrc` events list row *(B4)*
   - `/scrc` events detail *(B3)*

**C — the rejection split**

10. Submit another event. As jcrc, **Request changes** with a reason.
    *Expect:* head sees badge **"Changes needed"**, the reason pinned, an editable form, and
    a **Submit for review** button. Edit and resubmit → badge **"In review"**, and the
    reviewer's old reason is **cleared** (T3).
11. Submit another. As jcrc, **Decline** with a reason.
    *Expect:* head sees **"Declined"**, the reason, no edit form, no resubmit button.
    Verify in the DB that no further transition is possible — the API refuses.
12. Try **Approve** on an event that another tab already declined.
    *Expect:* `This event has already been decided. Reload the page.`

**C2 — `submitted` is locked, and withdraw is the way out (ruling C-2)**

12a. Submit an event. As the head, open it.
     *Expect:* **no editable form.** The panel reads "Submitted — waiting for JCRC review."
     with "You can't edit it while it's in the queue…", and a **Withdraw** button is
     present. Confirm there is no title field, no date field, no banner uploader.
12b. Call `event.update` on that eventID directly (bypassing the UI).
     *Expect:* refused with `EVENT_LOCKED`. **This is the ruling's actual guarantee — a UI
     that merely hides the form is not enough.**
12c. Press **Withdraw**. Confirm the dialog text matches §8.12 verbatim.
     *Expect:* badge → **"Not submitted"**, the form is editable again, and the event has
     **left** the JCRC queue at `/admin/events`.
12d. Edit the title, resubmit.
     *Expect:* badge → **"In review"**, back in the queue, sorted to the **end** (the queue
     orders `updatedAt asc`).
12e. Check the audit trail: one `event.submit`, one `event.withdraw`, one `event.submit`.
12f. **The race (T-10).** Two browsers. As jcrc, open the review detail for a submitted
     event. In the other browser, as the head, withdraw it. Back in the JCRC tab, refresh
     the detail.
     *Expect:* the **withdrawn panel** from §8.11 — "This event was withdrawn" — **not**
     the three decision buttons, and **not** `NO_SUCH_EVENT`.
12g. Same setup, but in the JCRC tab press **Approve & publish** *without* refreshing.
     *Expect:* refused with "This event has already been decided. Reload the page." and the
     event is still `draft`. Nothing was published.

**D — signup, capacity, cancel**

13. Two residents sign up for the capacity-2 event from step 1; a third tries.
    *Expect:* third gets `This event just filled up.` (`EventLock` + capacity path, D-13,
    unchanged).
14. Head cancels the published event.
    *Expect:* the two-consequence confirmation from §8.9 (timeline / places / booking), the
    event leaves `/events`, and the `Bookings` row is **gone** — the facility is free again.
15. As jcrc, cancel a *different* published event via **Cancel the event**.
    *Expect:* same outcome, plus a `RoleAuditLog` row with `action: "event.cancel"` whose
    `actorRoles` contains `jcrc`.

**E — duplicate**

16. Duplicate a published event.
    *Expect:* a new event, badge **"Not submitted"**, same title + " (copy)", same times,
    location, capacity and public description; **banner and photos empty**; no
    `decisionReason`, no `bookingID`. The original is untouched and still published.
17. Duplicate a **hall** event.
    *Expect:* the copy also has `ccaID: null` and shows **Hall**.

**F — authorisation (the part a passing build says nothing about)**

18. As the CCA head (not jcrc), request `/admin/events/hall/{id}` for the hall event.
    *Expect:* refused. Also call `event.update` on that eventID directly — expect
    `CAPABILITY_REQUIRED:manageHallEvents`, **not** `NOT_A_HEAD_OF_THIS_CCA`.
19. As an `scrc` holder: `/scrc` events tab shows every event **read-only**. Confirm there
    is no create, edit, approve or cancel control anywhere, and that a direct
    `event.create` call is refused (D-9).
20. **Kill switch.** `set-events-flag.mjs off --commit`, wait 15s, reload `/events`.
    *Expect:* `Events aren't available yet — check back soon.` Every surface inert.
    Turn it back on.

**G — the upload boundary**

21. As head A, get an upload token for head B's event (POST `/api/event/upload` with
    `pathname: "event/{B's id}/banner"`).
    *Expect:* rejected. Repeat for a hall event as a non-jcrc head — also rejected.
22. Confirm `pathname: "event/{id}/proposal"` is now rejected as `BAD_PATHNAME` (D-1
    removed it from the regex).

---

## 12. Traps in this change

Ordered by how expensive the mistake is, not by how likely.

### T-1 — `ccaID: event.ccaID ?? 0`, never `?? null`, never `!`

`event.ts:901`. When `ccaID` goes nullable, this line stops compiling. There are three
"fixes" and two of them are wrong:

| "Fix" | Outcome |
|---|---|
| `ccaID: event.ccaID!` | Compiles. Writes `null` into a required Int at runtime. Prisma throws on the *read* — so the failure surfaces later, in someone else's query, on a booking nobody can explain. |
| `ccaID: event.ccaID ?? null` | Does not compile *(good)* — but the coder's next move is often to make `Bookings.ccaID` nullable, which is the actual catastrophe: two values meaning absent in a 17,456-row collection where `0` already means it, `cascade.ts:47` guards only `0`, and `BookingModal.tsx:115` writes only `0`. |
| **`ccaID: event.ccaID ?? 0`** | **Correct.** `0` is the reserved sentinel, 3,839 rows deep, already guarded. |

**`Bookings` does not change. If the diff touches `model Bookings`, the change is wrong.**

### T-2 — `cascade.ts` needs no edit, and here is why you must check anyway

`deleteCcaCascade` (`cascade.ts:46-55`) does `tx.bookings.deleteMany({ where: { ccaID } })`
and refuses `ccaID === 0`. For hall events that is exactly right: their bookings carry `0`,
so no CCA delete can ever sweep them up.

The interaction that *is* worth knowing, and that this change does not create but does
make more reachable: for a **CCA-owned** event, `deleteCcaCascade(N)` deletes the event's
auto-created booking (it carries `ccaID: N`) but leaves `Event.bookingID` pointing at it,
and does not touch the `Event` row at all. That is pre-existing — `Event` is absent from
`deleteCcaCascade`'s cleanup list — and it is out of scope here. **Do not add `Event` to
that cascade in this change.** `deleteCcaCascade` has no UI caller
(`cascade.ts:28-31`: "NO UI REACHES THIS"), so the exposure is script-only. Record it;
do not fix it here.

### T-3 — a duplicated banner URL fails the security check, not a null check

`isOwnEventBlobUrl(url, eventID, kind)` requires the path to start with
`/event/{eventID}/{kind}` (`schemas/event.ts:168`). Copying `bannerUrl` from event 12 to
event 13 produces a URL that **the load-bearing blob check rejects** — so the duplicate
would look fine until its first save, then fail with `NOT_A_VALID_EVENT_BLOB_URL` from the
one function that must never be loosened.

The wrong fix is to relax `isOwnEventBlobUrl` to accept any `event/*` path. That would let
a head attach another CCA's private image to their own event by URL. **D-19 is the fix:
don't copy images.** `isOwnEventBlobUrl` is not to be edited in this change at all.

### T-4 — two "Hall" sites render nothing rather than something wrong

`EventsTimeline.tsx:189` and `EventDetail.tsx:113` both guard with `{e.ccaName && …}`.
A hall event has `ccaName === null`, so the owner line **silently disappears** on the two
resident-facing pages. No error, no warning, no `tsc` complaint — the element is simply not
in the DOM. The four `CCA #${ccaID}` sites (§7.2) at least render visible garbage that a
tester will notice; these two will pass a casual browse. §11.2 step 9 tests all six by
name for this reason.

### T-5 — `prisma db push` on this cluster drops `email_unique_ci`

`schema.prisma:469-470` and `index-census.mjs:26-29` both say so, and it has happened
before. This change needs **no** push (ruling C-1, §0.6, §9.3). If one is run anyway, the
census diff in Appendix A.2 is the only detector, and a case-duplicate account can form in the window between the
drop and the restore — after which the restoring `createIndexes` fails with `E11000` and
you are in `merge-by-canonical.mjs` territory.

### T-6 — deleting a status is a `tsc` error in one place and a silent reinterpretation in another

`STATUS_META` (`format.ts:93`) is `Record<EventStatus, …>` — exhaustive, so removing
`approved`/`rejected` **fails the build** there. Good.

But `normalizeStatus` (`schemas/event.ts:44-48`) maps anything unrecognised to `"draft"`.
If a row somehow held `"approved"`, it would read as **"Not submitted"** — an event the
JCRC approved, displayed to its head as never submitted, with an editable form. §0.1
measures 0 rows so this cannot happen today; check [5] of `verify-events-schema.mjs` is
what keeps it from happening quietly later.

### T-7 — `listForOversight` filters the RAW column while returning the NORMALISED one

`event.ts:1044-1051` documents this deliberately: `where: { status: input.status }` matches
the stored string, but the returned `status` is `normalizeStatus`'d, so a row stored as
`null` reads "draft" and does **not** match a `draft` filter. That comment and that
behaviour are **correct and must survive the rename intact**. Do not "fix" it by adding
`OR: [{ status: null }]` — that would make "draft" mean something different here than in
`editScope` and in `decide`'s guard. The user-facing explanation at
`EventsOversightPanel.tsx:288-291` stays too.

### T-8 — `AuditEntry.targetCcaID` is `number | undefined`, not `number | null`

`admin.ts:410`. So `targetCcaID: event.ccaID` breaks at all four existing sites and the
correct spelling is `event.ccaID ?? undefined`. Writing `?? null` does not compile; writing
`as number` compiles and writes garbage. This is a small trap that appears four times.

### T-9 — the `NO_SUCH_CCA` check must run *after* the null branch, not before

`create` (§5.5). A "tidy" refactor that hoists the
`db.cCA.findUnique({ where: { ccaID: input.ccaID } })` above the branch will refuse **every
hall-wide event**, because there is no CCA row to find. The check is real and must stay —
it just belongs inside the non-null arm.

### T-10 — a withdraw can land while the JCRC has the review form open

Ruling C-2 removed the moving-target problem and replaced it with a smaller, sharper one:
`withdraw` is a real transition that can fire while a reviewer is mid-decision.

Three things must all be right, and only the first is automatic:

1. **The write is already safe.** `decide` guards
   `normalizeStatus(event.status) !== "submitted"` (`event.ts:849`), so a decision landing
   after a withdraw is refused with `NOT_UNDER_REVIEW`. Nothing is lost or mis-saved. **Do
   not weaken that guard** to "be helpful" about the race.
2. **The read must not present a stale form.** `getForReview` returns whatever the record
   now says. `EventReviewDetail` must branch on the fetched status and render the withdrawn
   panel from §8.11 — **not** the three decision buttons over a record that is no longer
   decidable. Today it branches only on "already decided" (`:134-140`), and a `draft` status
   would fall through to the live form.
3. **The list must not 404 on click.** `listForReview` drops the row on its next fetch, so a
   reviewer who clicks a stale row reaches `getForReview` for a `draft` event. That must
   render the withdrawn panel too — **not** `NO_SUCH_EVENT`, because the event does exist
   and saying otherwise sends the reviewer looking for a deleted record.

The trap is that (1) passing makes the feature *look* correct in testing, because the
data is never corrupted. (2) and (3) are pure UI and will be missed unless tested
deliberately — §11.2 C step 12a does exactly that, with two browser tabs.

**`getForReview` is not narrowed to `submitted`.** It must keep returning non-submitted
events so the panel has something to render; the queue is what filters, not the detail
fetch.

**4. The write must be atomic, and point (1) above overstates what a `findUnique` + `if`
buys you** *(added during review — this was missed, and it is the only half of T-10 that
can corrupt data).* "The write is safe: `decide` throws `NOT_UNDER_REVIEW`" is true only
between the read and the write. `findUnique` then `update({ where: { eventID } })` is a
textbook check-then-act: the reviewer loads a `submitted` row, the withdraw lands, and the
update writes `published` **over the draft**. That is the transition `draft → published`,
which §2.1 does not list because it does not exist — an event live on the residents'
timeline that its owner believes they pulled back, carrying a `publishedAt` and a decision
for a submission nobody made.

`withdraw` has the mirror hole and the worse outcome: read `submitted`, reviewer approves,
write `draft`. A **published** event silently reverts to a draft with `publishedAt` still
stamped and its auto-created `Bookings` row still holding the room. It disappears from the
timeline with no cancellation, no booking release and no audit row, because `published →
draft` is not a transition anything audits.

The fix in both is to put the status in the `where` so the match and the write are one
atomic document operation, and to throw on a zero count:

```ts
const applied = await ctx.db.event.updateMany({
  where: { eventID: input.eventID, status: "submitted" },
  data: { /* … */ },
});
if (applied.count === 0) {
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NOT_UNDER_REVIEW" });
}
```

Keep the `findUnique` pre-check: it still separates `NO_SUCH_EVENT` from a bad status, it
supplies the row the audit write needs, and it is what reports the ordinary uncontended
case. Matching the RAW column here is **not** the T-7 trap — `normalizeStatus`'s fallback
is `"draft"`, so `"submitted"` is never a value it invents, and raw and normalised select
the identical set of rows.

### T-11 — hall events publish through two calls, and both must re-check live

Ruling D-27. "Register and publish" is `submitForReview` followed by `decide(approve)`,
sequenced by the client (§5.8). Three ways to get it wrong:

- **Fusing them into one server procedure.** That procedure would have to re-implement
  `decide`'s live `getUserRoles` + `computeCapabilities(roles).reviewEvents` check
  (`event.ts:836-841`) — a second copy of the one guard that catches a role revoked
  mid-session. Call the real procedures instead.
- **Rolling back to `draft` when step 2 fails.** Do not. The event is legitimately
  `submitted` and any reviewer can finish it; an automatic rollback means a transient
  network error silently un-submits a real submission. §8.13's copy says so plainly.
- **Suppressing the `event.submit` audit row** because "nobody reviewed it". That row plus
  the `event.approve` row, same actor, seconds apart, *is* the evidence of a self-approval
  (D-22). Two rows with one actor is the fact an auditor needs.

Rendering the button is gated on `ccaID == null` for clarity only. Security comes from
`decide` sitting on `roleManagerProcedure`, which refuses a CCA head regardless.

§8.11. A JCRC-created event still needs a `decide` call to publish, i.e. the JCRC submits to
itself. The plan recommends keeping that loop (option **a**) and using the copy that admits
it. **Do not implement option (b)'s auto-publish without the human's word** — it adds a
second path to `published` that bypasses `decide`, and therefore bypasses the live
`reviewEvents` re-check at `event.ts:836`.

### T-12 — write `ccaID: null` EXPLICITLY; never omit the field

`create` (§5.5) and `duplicate` (D-11) must both pass `ccaID: null` in the `data` object
for a hall event. Omitting it writes a document with **no `ccaID` key at all**, and this
codebase has a standing rule about exactly that, recorded at
`docs/plans/cca/01-group-interview-slots.md` §0.4:

> `{ canceledAt: null }` matches a stored null but **NOT an absent field**, so freshly
> written rows must set every optional scalar EXPLICITLY and every "is it null" test is
> done in JS.

`listForOwner`'s hall branch queries `where: { ccaID: null }`. A row written without the
key would be **invisible to the only list that can reach it** — created successfully,
then unmanageable, with no error anywhere. Prisma's Mongo connector will happily read the
row back as `ccaID: null` when you `findUnique` it by `eventID`, so the bug survives every
test that fetches one event by id and only shows up in the list.

The same applies to `duplicate`, which must set every reset field to an explicit `null`
(`decidedAt`, `decidedBy`, `decisionReason`, `publishedAt`, `bookingID`) rather than
leaving them out.

**And it applies to the four inert D-17 fields, in BOTH writers** *(added during review)*.
The tempting argument is that the hazard only bites a field some `where` clause
null-matches, and that none of `attendanceOpensAt` / `attendanceClosesAt` /
`scannerUserIDs` / `answersPurgedAt` is queried by anything today. That argument is
*correct about today* and is exactly why the omission is dangerous: D-17's stated purpose
is that **the attendance and purge phases need no second schema pass**, which means those
phases will run their queries against rows created *now*. The first query the purge phase
writes is the obvious one —

```ts
where: { answersPurgedAt: null }   // events whose answers still need purging
```

— and every Phase-1 row would be invisible to it, silently and permanently. The retention
sweep would report zero work to do while the answers sat there. Four explicit `null`s (and
`scannerUserIDs: []`) in `create` and `duplicate` cost one line each. "No query reads it
yet" is a statement about the present tense of a field whose entire justification is the
future tense.

### T-13 — `parseCcaID` is reused to parse event ids, and it rejects 0

`src/app/cca/_lib/ccaParam.ts`'s `parseCcaID` is used for the **eventID** segment at
`src/app/admin/events/[eventID]/page.tsx:10` and
`src/app/cca/[ccaID]/events/[eventID]/page.tsx:17`. It rejects non-positive integers, which
is harmless for event ids (the counter starts at 1). The new
`/admin/events/hall/[eventID]/page.tsx` (D-20) must parse the same way — copy the existing
route, do not invent a parser. And note the corollary: **no route segment can ever encode
"hall"**, which is why the hall surface gets its own path prefix instead of a magic
`/cca/0/events`.

### T-14 — `assertHeadsCca` must not learn about null

It is shared with `cca.updateProfile`, `cca.removeMembers`, `cca.handoverHeads`,
`cca.memberDirectory` and the CCA application flow. Its own comment (`ccaScope.ts:78-88`)
argues at length that widening it hands all of that to whoever gains the new branch. The
null case belongs in `loadOwnedEvent` (§5.4) and **nowhere else** — including the upload
route, which gets its own copy of the branch on purpose, right next to the `select` that
produced the nullable value.

### T-15 — the cancels are the OTHER half of T-10, and they hold the room

**Added by the SECOND review pass.** T-10 made `decide` and `withdraw` atomic and stopped
there. `cancelEvent` and `reviewerCancel` are the same check-then-act shape over the same
rows, and they are worse, because they are the two procedures that free a facility:

1. `cancelEvent` loaded the row, checked the status, then wrote `status: "canceled",
   bookingID: null` with an unscoped `update`. A reviewer approving in that window turned
   a `submitted` row into a `published` one with a Bookings row attached — and the cancel
   then wrote over it and freed nothing, because the cleanup was deciding from the
   pre-race row it had loaded. **A canceled event silently kept the room, with the only
   pointer to the booking nulled out.**
2. `releaseEventBooking` took the caller's already-loaded row, and ran *after* the caller
   had nulled `bookingID`. It now takes an `eventID`, re-reads `bookingID` after the
   status write, deletes the Bookings row, and nulls the pointer **second** — that order
   is load-bearing, because the reverse loses the pointer when the delete fails.
3. `decide` stamps `bookingID` in a **separate write** after it publishes: the auto-book
   takes a facility lock, scans for conflicts and creates the row first. A cancel landing
   in that window was handed a live `bookingID` written onto an already-canceled event.
   That write is now scoped on `status: "published"`, and if it does not apply the booking
   just created is **deleted** — nothing may hold a facility for a non-published event.
   This is the new `autoBook: "released"` outcome, distinct from `"conflict"` (the slot was
   never free) because it is a different fact about the room, and it has its own audit
   reason.

Rule: **every write in this router that changes `status` puts the status it requires in the
`where`.** There are now five (`decide`, `withdraw`, `cancelEvent`, `reviewerCancel`, and
`decide`'s booking stamp). `cancelEvent` spells its guard as `NOT: { status: { in:
["declined", "canceled"] } }` rather than a positive `in` list, because `normalizeStatus`
maps null and anything unrecognised to `"draft"`, which IS cancelable — the negative
spelling is the one that matches the pre-check row for row.

### T-16 — an error message cannot live in a component the error unmounts

**Added by the SECOND review pass.** `registerAndPublish`'s step-2 failure copy (§8.13) was
written into `DetailsEditor`'s local `error` state and then followed by `onInvalidate()`.
That refetch is what makes the message TRUE — it moves the event to `submitted` — and it is
also what destroys it: `editScope` stops being `"all"`, and the editor unmounts with the
message inside it. The head saw the submitted panel and **no explanation at all**, which is
the exact failure the carefully-worded string was written to prevent.

The message is hoisted to `EventManage` (`onHandoff`) and rendered beside the submitted
panel. The copy also changed: the frozen text said *"Try publishing again"*, and that panel
offers Withdraw and Cancel and **no publish control** — so it now links to
`/admin/events/{eventID}`, which is where "Approve & publish" actually lives.

Generalise it: **a message about a transition must be rendered by a component that survives
the transition.**

### T-17 — a shared block's copy is part of the surface that reuses it

**Added by the SECOND review pass.** §8.2 hall-branched `EventCreateForm`'s footer and
`EventsListPanel`'s empty state. Both of those components render `EventDetailsFields`
directly above the sentence they fixed, and that block still carried three strings naming
the JCRC as a REVIEWER — *"JCRC reads this when they review it"*, *"Tell JCRC about your
event…"*, *"If JCRC approves, this facility is booked automatically"*. A JCRC member
filling in their own hall event was told twice on one screen that the JCRC would review it.
Two further sites in `EventReviewDetail.tsx` had the same defect one screen over: the
approve notice's *"the CCA head is told to book it themselves"* and `ReviewerCancelPanel`'s
*"The CCA head is not asked first"* — the latter roughly sixty lines below the withdrawn
panel §8.11 had already corrected.

The rule §8.11 states for one string applies to **every** string on a surface that a
hall event can reach: if it names a CCA head, it must branch on `isHall`. The count of such
sites is five, not two.

### T-18 — an inert field is still a field the redaction list has to know about

**Added by the SECOND review pass.** D-17 lands four Phase-2 fields, and `scannerUserIDs`
holds CANONICAL userIDs — the same class as `createdBy` / `decidedBy` / `updatedBy`, whose
whole reason for being in `SCRC_HIDDEN_EVENT_FIELDS` is that a canonical id is an email
address one derivation later. It was not in the list. Inert today, so it costs nothing
today; the day the attendance phase populates it, `getForOversight` hands the hall office a
directory of every door scanner in the hall, **with no diff to `routers/event.ts` to
notice**. It is now blanked — to `[]` rather than null, because it is a list and "nobody" is
the honest empty value, and because that keeps the field's type intact for the client.

This is D-17's own argument (write the inert fields explicitly *because* omitting them is
harmless today) applied to the read side, and it generalises: **when a field is added to a
model, it must be classified against every projection that model already has.** The other
three Phase-2 fields are timestamps, not identities, and stay.

---

## 13. What Phase 2 inherits

Recorded so the inert fields (D-17) are not mistaken for dead code, and so the next planner
knows what was deliberately left:

- `attendanceOpensAt` / `attendanceClosesAt` / `scannerUserIDs` / `answersPurgedAt` exist,
  are indexed by nothing, and are read by nothing.
- The audit log UI still renders no `targetCcaID` / `targetEventID` (C-4).
- `event.ts:886-895` still duplicates `findFacilityConflict` unless the optional cleanup in
  §5.2 was taken.
- `deleteCcaCascade` still does not clean up `Event` rows (T-2).
- No notification is sent on any transition. A head learns their event was declined — or
  that their withdrawn event is editable again — by opening the page. `withdraw` in
  particular tells the JCRC nothing; the event simply leaves the queue.
- The audit log's Target column still renders neither `targetCcaID` nor `targetEventID`
  (C-4), so every event row shows `—`. Making event rows legible in `/admin/audit` is a
  self-contained Phase 2 task.
- `getForReview` is not narrowed to `submitted` (T-10), so it remains a read of any event
  by any manager. That is intentional and should stay if a reviewer history view is ever
  built.

---

## Appendix A — the `prisma db push` procedure

> **DO NOT RUN THIS IN PHASE 1.**
>
> Ruling C-1 removed `db push` from the rollout. §9.3 is the procedure. This appendix
> exists so that (a) the reasoning is not lost, and (b) if a *future* phase genuinely adds
> an index, whoever does it has the guarded steps rather than inventing them under
> pressure.

### A.1 Why a push is dangerous on this cluster

`prisma db push` cannot represent a collation index in the Prisma schema, so it classifies
`User.email_unique_ci` as "not in schema" and **drops it** — silently, without needing
`--accept-data-loss`. That index is the only thing preventing two rows differing solely in
letter case from becoming two accounts for one human, which is the duplicate-account class
this repo has hand-remediated four times (`merge-by-canonical.mjs`,
`fix-claresta-duplicate.mjs`, `fix-lgd-duplicate.mjs`, `merge-mingyuan-duplicate.mjs`).

It has been dropped and restored on this cluster before. Both `prisma/schema.prisma:469-470`
and `scripts/remediation/index-census.mjs:26-33` document it, the latter stating the rule
outright: *"NEVER run `prisma db push` or `prisma migrate` on this cluster."*

### A.2 If a future phase must push anyway

```bash
node scripts/remediation/index-census.mjs > census-before.txt
npx prisma db push
node scripts/remediation/index-census.mjs > census-after.txt
diff census-before.txt census-after.txt
```

**The only acceptable diff is the indexes that phase deliberately added.** Any *removed*
line is a dropped index and must be restored before the cluster takes another write.

### A.3 Restoring `email_unique_ci`

```js
db.runCommand({ createIndexes: "User", indexes: [{
  key: { email: 1 }, name: "email_unique_ci", unique: true,
  collation: { locale: "en", strength: 2 } }] })
```

This will fail with `E11000` if case-duplicate accounts formed during the window the index
was absent. **That failure is the point** — it is the detector, not a problem with the
command. `merge-by-canonical.mjs` is the remedy; run it, then re-run the `createIndexes`.

### A.4 The one red line

`verify-events-schema.mjs` check [2] and `index-census.mjs`'s `GUARD_INDEX` both watch this
index. If either reports it missing, **stop everything else** and restore it first.
