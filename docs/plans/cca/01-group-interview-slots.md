# 01 — Group interview slots (capacity > 1)

**Ask:** a CCA head can decide that a given interview slot takes _N_ people instead of
one, N chosen by them.

**Status:** proposal. Nothing below is implemented.

---

## 0. Ground truth, verified against the repo

### 0.1 The slot is a single-seat row

`prisma/schema.prisma:532` — `CcaInterviewSlot` carries the claim as three scalars on
the slot itself:

```prisma
bookedByUserID      String?
bookedApplicationID Int?
bookedAt            DateTime?
```

"Free" is spelled `bookedByUserID === null` in nine places. There is no seat entity and
no count anywhere — occupancy is boolean by construction.

### 0.2 The claim is already mirrored on the application

`CcaApplication.interviewSlotID` (`prisma/schema.prisma:494`) points back at the slot,
and **every writer maintains both sides inside one `withCcaLock` section**:

| Site | Slot side | Application side |
|---|---|---|
| `ccaApplications.bookSlot` (`ccaApplications.ts:568`) | sets all three | `interviewSlotID = S`, status `interview_scheduled` |
| `ccaApplications.cancelSlot` (`:647`) | `releaseSlotIfMine` (`:71`) | `interviewSlotID = null`, status `submitted` |
| `ccaApplications.withdraw` (`:690`) | `releaseSlotIfMine` | `interviewSlotID = null`, status `withdrawn` |
| head `cancelSlot` (`ccaApplicationsHead.ts:520`) | `canceledAt` + clears claim | conditional revert to `submitted` |
| head `decide` → reject (`:823`) | clears claim **iff the slot is still future** | pointer deliberately **left** |
| head `decide` → accept (`:750`) | untouched | untouched |

So the system already has two sources of truth for "who holds this slot", kept in step by
the per-CCA advisory lock. That is the thing to collapse, not to duplicate.

### 0.3 What serializes a booking today

`withCcaLock` (`services/ccaApplications.ts:138`) — a `BookingLock` document per
`ccaApp:{ccaID}`, 30s staleness reclaim, the same mechanism `withFacilityLock` uses for
room bookings. Every check-then-write in this workflow already runs inside it: two
residents claiming a slot, the one-open-application check, two heads deciding at once.

### 0.4 The null-vs-absent trap, restated

`listSlots` (`ccaApplicationsHead.ts:303`), `openSlots` (`:365`), `clearFreeSlots`
(`:607`) and `availableSlots` (`ccaApplications.ts:536`) all carry the same comment:
**`{ canceledAt: null }` matches a stored null but NOT an absent field**, so freshly
written rows must set every optional scalar EXPLICITLY and every "is it null" test is
done in JS. Any new optional field inherits this rule.

### 0.5 Everything that reads the claim

Nine server sites (above, plus `listSlots`, `clearFreeSlots`, `getCca.openSlotCount`
`ccaApplications.ts:265`, `availableSlots` `:551`) and four client ones:
`InterviewSlots.tsx` (`freeCount:79`, `ScheduleView:452`, `SlotCard:539`),
`CcaApplyPanel.tsx` (`SlotPicker`), `InterviewSessions.tsx` (run-sheet, reads the
application's slot, not the claim), `MyApplicationsList.tsx` (own slot time only).

---

## 1. The design question

Occupancy has to become a **number compared against a capacity**. Three ways to hold it.

### Option A — seats as extra slot rows

Capacity 3 = open three identical rows. No schema change.

**Rejected.** `openSlots` refuses identical times as `DUPLICATE_SLOT` (`:384`) and
overlapping times as `SLOT_OVERLAP` — those guards are precisely what stops a head
double-opening a day, and relaxing them for this is how that protection dies. The head's
schedule would render N identical cards, "edit seat 2 of 3" is meaningless, and lowering
capacity means picking which rows to cancel. The zero-schema-change benefit is spent
entirely on UI grouping that has to be written anyway.

### Option B — a `CcaInterviewBooking` collection (one row per seat)

`capacity Int?` on the slot, seat claims in their own collection with
`@@unique([slotID, userID])` and `@@unique([applicationID])`.

**Viable, and the strongest concurrency story:** with a unique index the database itself
refuses a double claim, rather than the advisory lock. Cost: a new collection, a real
backfill of every existing booked slot, and a third representation of "who holds this
slot" living beside `CcaApplication.interviewSlotID` — a new drift pair of exactly the
kind CH-1 documents.

### Option C — capacity on the slot, occupancy DERIVED from the applications ✅

```
occupancy(S) = |{ CcaApplication : interviewSlotID === S }|
```

Add `capacity Int?` to the slot; **delete `bookedByUserID`, `bookedApplicationID`,
`bookedAt`**. The application's pointer becomes the single source of truth for a claim.

**This is the recommendation.** Why:

1. **It removes a source of truth instead of adding one.** The mirror in §0.2 collapses
   to one side. No new drift pair, no backfill of claim data — the data already exists on
   the application side and is already maintained under the lock.
2. **"One application, at most one seat" becomes structural.** The pointer is a single
   scalar, so an application cannot hold two seats and cannot be counted twice — the
   property Option B needs a unique index to buy. Re-booking the same slot is idempotent
   for free.
3. **Every missed reader is a compile error.** Deleting the three scalars from the Prisma
   model means any code still asking `slot.bookedByUserID` fails `tsc`, instead of
   silently reading "free" on a full slot. That is the mitigation this codebase's own
   sentinel-bug-class doc argues for: make the absent value visible to the type system.
4. **Capacity 1 is byte-for-byte today's behaviour**, so the rollout is inert until a
   head types a bigger number.

**What Option C gives up:** over-booking is prevented by `withCcaLock`, not by a unique
index. That is the same guarantee the current single-seat claim, the one-open-application
check, and the two-heads-deciding check already rely on. If that is judged insufficient,
Option B is the upgrade path and the seat rows can be introduced later without changing
the capacity field or any UI.

---

## 2. The model

```prisma
model CcaInterviewSlot {
  id        String    @id @default(auto()) @map("_id") @db.ObjectId
  slotID    Int       @unique(map: "slotID")
  ccaID     Int
  startTime Int?
  endTime   Int?
  location  String?
  createdBy String?
  /// How many applicants may claim this slot. ABSENT/null means 1 — every row
  /// written before group slots existed. Normalise through slotCapacity() and
  /// NEVER inline `?? 1`, so the legacy default lives in exactly one place.
  capacity  Int?
  canceledAt DateTime?
  createdAt  DateTime? @default(now())

  @@index([ccaID, startTime, endTime], map: "cca_time")
}
```

Removed: `bookedByUserID`, `bookedApplicationID`, `bookedAt`, `@@index([bookedByUserID])`.

On `CcaApplication`, add `@@index([interviewSlotID], map: "slot")` — occupancy is now a
query on this field.

**Prisma db push drops non-schema indexes.** List indexes on both collections before and
after the push and restore anything not declared (this has bitten `email_unique_ci`
before).

---

## 3. Server rules

One helper module owns the arithmetic — `services/ccaApplications.ts`:

```ts
export const SLOT_CAPACITY_DEFAULT = 1;
export const SLOT_CAPACITY_MAX = 20;

/** Absent/null/0/negative all mean one seat. The ONLY place this default lives. */
export function slotCapacity(c: number | null | undefined): number

/** slotID -> seats taken, for one CCA. Projects interviewSlotID ONLY — this is
 *  called on a resident path and must never read another applicant's row. */
export async function occupancyBySlot(db, ccaID): Promise<Map<number, number>>
```

| Rule | Behaviour |
|---|---|
| **Claim** | inside `withCcaLock`: `occupancy(S) >= capacity(S)` → `SLOT_FULL`. `SLOT_TAKEN` is retired. |
| **Re-claim same slot** | idempotent; the pointer already equals S, occupancy unchanged. |
| **Release** | `interviewSlotID = null` on the application. `releaseSlotIfMine` disappears — there is no slot-side state left to release. |
| **Free (for `clearFreeSlots`)** | `occupancy === 0`. A partially-filled slot is NOT free and is never bulk-cleared. |
| **Edit time/location** | refused while `occupancy > 0` (today: refused while booked). Unchanged in spirit. |
| **Edit capacity** | allowed at any time, including on an occupied slot. **Raising** re-opens the slot immediately. **Lowering below current occupancy** → `CAPACITY_BELOW_OCCUPANCY`, refused: nobody is evicted by an edit. |
| **Head cancels a slot** | reverts **every** occupant to `submitted` (today: one), in one locked section, one audit row with a `batchId`. Confirm copy must name the count. |
| **Reject one occupant** | frees that seat only — null that application's pointer when the slot is still future, which is exactly today's rule expressed on the pointer instead of the slot. |
| **Accept** | leaves the pointer, as today: an accepted applicant's interview stays on the record. |
| **Overlap between slots** | unchanged. A group slot is still one room at one time. |
| **`MAX_SLOTS_PER_OPEN`** | unchanged at 50 slots. Seats cost no rows, so 50 × 20 is fine. |

### Privacy

A resident sees **counts only** — "3 of 5 seats left" — never who else booked. The head
sees the roster. `occupancyBySlot` projects `interviewSlotID` and nothing else, so no
applicant PII is even loaded on the resident path.

---

## 4. Schema (zod) changes — `src/lib/schemas/ccaApplication.ts`

```ts
export const SLOT_CAPACITY_MAX = 20;
const capacity = z.number().int().min(1).max(SLOT_CAPACITY_MAX);

slotDraftSchema: + capacity.default(1)          // applies to the whole generated batch
editSlotInput:   + capacity.optional()          // omitted = leave unchanged
```

The SECURITY note at the top of that file still holds: `capacity` is a head-only field
and must never appear on a resident input.

New error vocabulary: `SLOT_FULL` (replaces `SLOT_TAKEN`), `CAPACITY_BELOW_OCCUPANCY`.
Both need copy in `InterviewSlots.tsx` and `CcaApplyPanel.tsx`.

---

## 5. UI

**Head — slot generator (`InterviewSlots.tsx:147`).** One new control beside "Minutes per
interview": **"People per slot"**, default 1, presets 1 / 2 / 3 / 4 / 6 + custom. Applies
to every slot in the generated batch. Preview chips gain "×N" when N > 1.

**Head — slot card (`:539`).** Occupancy replaces the boolean:
`2/4 booked`, names listed (truncate past three, "+2 more"). Fill state becomes
three-way — white empty, amber partial, solid green full — so a half-empty group session
is visible at a glance. Day-tab counts become seats, not slots.

**Head — run-sheet (`InterviewSessions.tsx`).** Group applicants who share a slot under
one session header — `10:00–10:30 · 4 applicants` — instead of four sibling rows. This is
where a group interview actually gets run, and it is the main reason not to model seats as
separate rows (Option A would fragment exactly this view).

**Resident — slot picker (`CcaApplyPanel.tsx`).** Each open slot shows seats left; a slot
with capacity > 1 is labelled **"Group interview · up to N people"**. Full slots are
filtered out exactly as taken slots are today.

> Turning up to a 1:1 and finding three other people is a bad surprise. The label is not
> decoration — it is the reason to show capacity to residents at all.

**Resident — `MyApplicationsList.tsx`.** No change; it shows the caller's own slot time.

---

## 6. Migration — `scripts/remediation/backfill-slot-capacity.mjs`

Dry-run by default, `--commit` to write, full pre-image backup first, verify at the end —
the house pattern (`reconcile-ccas.mjs`).

1. **Gate on agreement.** For every slot with `bookedByUserID` set, assert the matching
   application has `interviewSlotID === slotID`. Any disagreement is pre-existing drift:
   print it and **abort**. Deriving occupancy from a pointer that is already wrong would
   bake the error in.
2. **Write `capacity: 1` EXPLICITLY** on every existing slot — not absent (§0.4).
3. **Reconcile the reject case.** Null `interviewSlotID` on any application in a terminal
   status whose slot no longer names it (`bookedApplicationID !== applicationID`). This is
   the one place today's semantics live on the slot and not on the pointer; without it a
   rejected applicant would keep occupying a future seat.
4. **`$unset`** `bookedByUserID`, `bookedApplicationID`, `bookedAt`.
5. **Verify:** no slot has occupancy > capacity; per-slot occupancy after == booked count
   before; counts and the backup file are printed.

Reversible: the backup holds every pre-image, and the three scalars are re-derivable from
the application pointers.

**Verification script** — extend the `verify-cca-roster.mjs` pattern with
`verify-interview-slots.mjs`: occupancy ≤ capacity everywhere, no application pointing at
a canceled or non-existent slot, no slot with capacity < 1.

---

## 7. Rollout

No new kill switch. The whole surface is already behind `cca.applications.enabled`
(`services/ccaApplications.ts:18`), and **capacity 1 is exactly today's behaviour**, so
the feature is inert until a head types a number greater than 1.

**The migration needs a quiesce window — this is not a zero-downtime change.** The flag
is currently ON and residents are using the feature. `backfill-slot-capacity.mjs`
snapshots both collections and then, in step 4, deletes the field that says which
applicant a slot last belonged to. A head who REJECTS an applicant holding a future slot
inside that window creates a reject-orphan the run cannot see — and once the field is
gone, a re-run cannot classify it either, so the seat is held by a rejected application
permanently while every check reports healthy. `--commit` therefore REFUSES to run while
the flag is on (`--allow-live` overrides, and prints what it is risking).

Order:

```
node scripts/remediation/set-cca-flag.mjs applications off --commit   # quiesce
node scripts/remediation/backfill-slot-capacity.mjs                   # dry run, read the plan
node scripts/remediation/backfill-slot-capacity.mjs --commit          # migrate
npx prisma db push                                                    # then diff the index lists
node scripts/remediation/verify-interview-slots.mjs                   # must PASS
# deploy the new code
node scripts/remediation/set-cca-flag.mjs applications on --commit    # <-- DO NOT FORGET
```

The last line is the one that gets missed. The switch is default-closed, so leaving it off
locks every resident out of `/ccas` with no error anywhere. The window itself is seconds —
34 slots and 63 applications — so quiescing costs almost nothing and buys the one failure
mode of this migration that is both permanent and invisible.

Then: heads opt in per slot.

---

## 8. Files this touches

| File | Change |
|---|---|
| `prisma/schema.prisma` | `capacity`, drop three scalars + one index, add `interviewSlotID` index |
| `src/lib/schemas/ccaApplication.ts` | capacity bounds, `slotDraftSchema`, `editSlotInput` |
| `src/server/api/services/ccaApplications.ts` | `slotCapacity`, `occupancyBySlot`, constants |
| `src/server/api/routers/ccaApplications.ts` | `bookSlot` (`SLOT_FULL`), `availableSlots`, `getCca.openSlotCount` → seats, `cancelSlot`, `withdraw`, delete `releaseSlotIfMine` |
| `src/server/api/routers/ccaApplicationsHead.ts` | `openSlots`, `updateSlot`, `cancelSlot` (multi-revert), `clearFreeSlots`, `listSlots` (roster), `decide` |
| `src/app/cca/_components/InterviewSlots.tsx` | capacity control, occupancy card, edit form |
| `src/app/cca/_components/InterviewSessions.tsx` | group the run-sheet by slot |
| `src/app/ccas/_components/CcaApplyPanel.tsx` | seats left, group label |
| `scripts/remediation/backfill-slot-capacity.mjs` | new |
| `scripts/remediation/verify-interview-slots.mjs` | new |

Rough size: ~1 focused day, the migration and the run-sheet grouping being the two parts
worth reviewing closely.

---

## 9. Edge cases the implementation must answer

1. Legacy slot, `capacity` absent → 1, via `slotCapacity()` only.
2. Two residents race for the last seat → `withCcaLock` serializes; the loser gets
   `SLOT_FULL`, not a silent over-book.
3. Head lowers capacity 4 → 2 on a slot holding 3 → refused, message names the occupancy.
4. Head raises capacity on a full slot → bookable again immediately, no other write.
5. Resident re-books the slot they already hold → no-op, occupancy unchanged (structural).
6. Head cancels a group slot holding 4 → 4 reverts to `submitted`, one audit row, one
   confirm dialog that says "4 applicants".
7. One occupant rejected while the slot is future → that seat frees, the other three are
   untouched.
8. An occupant marked `interviewed` → pointer and seat both stay; the slot is history.
9. Slot in the past → never bookable (`endTime > now`), unchanged.
10. Capacity 1 throughout → the diff must be behaviourally invisible.

---

## 10. Decisions

Settled with the owner, 2026-08-02:

1. **Data model — Option C.** Capacity on the slot, occupancy derived from
   `CcaApplication.interviewSlotID`, the three booking scalars deleted. Over-booking is
   prevented by `withCcaLock`, the same guarantee the rest of this workflow trusts.
   Option B (seat rows + unique index) remains the upgrade path if that is ever judged
   insufficient — it changes neither the capacity field nor any UI.
2. **Residents see seats left, plus an explicit group label** — "Group interview · up to
   4 people — 3 seats left". Counts only; never who else booked.

Assumed unless the owner says otherwise:

3. **Max capacity 20.** Big enough for a mass audition, small enough that a typo is
   caught.
4. **Capacity is set per generated batch**, then editable per slot (subject to the
   never-evict rule in §3).
