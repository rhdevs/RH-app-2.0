# Transcript — Design and Data-Model Spec

> **How to read this document.** Sections 1 to 21 record the original proposal and the early phases as they were written. Some of what they describe was later removed or replaced: verification, the QR code, issuing and stored snapshots (section 22), the single-record `VolunteerRecord` (section 25) and one-at-a-time awards (section 26). Sections 22 onward describe the feature as built, and section 30 maps every requirement to its code and tests.

**Ask:** Each resident can download a generated end-of-Academic-Year (AY) transcript of their hall involvements, to (1) recognise their efforts and (2) formalise their involvements. Style target: an NUS Student Development Transcript.

**Scope (original):** the Phase 1 proposal. Everything it proposed was later built, changed or dropped as the later sections say.

**Status:** implemented. Open questions of the proposal are in section 10; the decisions taken are in sections 12 onward.

---

## 1. Summary and goals

A transcript is a formal, itemised, printable record of one resident's hall involvement for one AY (later: several AYs). It has five parts:

1. Resident header and verification block.
2. Involvements table: one row per CCA, with the resident's role (blank for plain members).
3. CCA glossary: a description of only the CCAs the resident is in.
4. Volunteer Hours: regular (usually via a CCA) and one-off (any resident).
5. Awards: special awards from the end-of-year Colours Awards.

Goals:

- Accurate and defensible: every line traces to a recorded fact entered by someone with authority to enter it.
- Gracefully handles incomplete data (many CCAs have no description; many residents have no volunteering or awards).
- Reuses what the app already has (CCA list, `CcaProfile`, `CcaHead`, `EventAttendance`, audit log, the existing `/transcript` and `/verify` prototype) rather than duplicating it.

Non-goals for Phase 1: any code, schema change, migration or seed data.

---

## 2. Findings from the codebase

Verified against `main` at `2d23570`. Repo conventions that constrain the design are listed first, because they shape every model below.

### 2.1 Conventions that bind new models

- **Database is MongoDB, not Postgres.** `prisma/schema.prisma:6-9` has `provider = "mongodb"` and the README badge says Prisma-MongoDB. `CLAUDE.md` says Postgres. See open question Q1.
- Legacy collections (`CCA`, `UserCCA`, `User`, bookings, and others) are `$jsonSchema`-validated. Adding fields to them fails silently (error 121). **New data goes in new, unvalidated sidecar collections.** `CcaProfile` (`prisma/schema.prisma:631`) is the existing example.
- Schema comment rule **I-1**: key everything on the canonical `userID` (`canonicalUserID(email)`, `src/lib/identity.ts`), never `User.userID`.
- Schema comment rule **I-2**: no required non-list scalars on new models; use nullable fields or defaults.
- `prisma db push` must never be run on the cluster (it drops `User.email_unique_ci`). Indexes are created via `scripts/remediation/*.mjs`.
- Authorisation must use a live `getUserRoles(db, userID)`, not the session copy, which can be up to 30 days stale (rule I-5; `src/server/auth.ts`, `src/server/api/services/access.ts`).

### 2.2 Existing models and fields

| Concept | Existing | File | Gap |
| --- | --- | --- | --- |
| Resident | `User` (`email`, `userID?`, `displayName?`, `block Int?`), `UserMatric{userID, matric}` | `prisma/schema.prisma` | No faculty, room or year field. Name and matric are available; "room" appears to be `block` only. |
| CCA list | `CCA{ccaID Int @unique, ccaName, category}` (`:179`) | `prisma/schema.prisma:179` | No description field. Managed at `/admin/manage-ccas`; CCAs are renamed in place so `ccaID` is stable. |
| CCA description | `CcaProfile{ccaID @unique, description String?, logoUrl?, bannerUrl?, updatedAt?, updatedBy?}` (`:631`) | `prisma/schema.prisma:631` | Nullable and written by heads, so many are empty. **Single current value, not per AY.** |
| Membership | `UserCCA{ccaID Int, userID String}` (`:1309`) | `prisma/schema.prisma:1309` | **No AY, no role, no history** (leaving deletes the row). `userID` is a mix of A-format matric and canonical E-format. No compound unique. |
| Head / leader | `CcaHead{userID, ccaID, grantedAt, grantedBy?}`, `@@unique([userID, ccaID])` (`:590`) | `prisma/schema.prisma:590` | Says who heads a CCA **now**. No title (head vs president vs leader), no AY, no exco concept. |
| AY / semester | none | n/a | Must be introduced (as a string convention, see 5.1). |
| Events | `Event{eventID, ccaID?, createdBy, title, startTime Int?, status?}`, `EventSignup` | `prisma/schema.prisma` | Usable as a source for hours or participation. |
| Attendance | `EventAttendance{eventID, userID, checkedInAt?, checkedInBy?, method, wasSignedUp}`, `@@unique([eventID, userID])` (`:1051`) | `prisma/schema.prisma:1051` | Per-event check-in only; no durations. |
| Volunteering / hours | none | n/a | New. |
| Awards / Colours | none | n/a | New. |
| Audit | `RoleAuditLog{at, actorUserID, actorRoles[], target*, action}` (`:402`), append-only; `AUDIT_ACTIONS` in `src/server/api/services/roles.ts:186` | `src/server/api/services/roles.ts:186` | New actions (for example `transcript.*`) must be added to `AUDIT_ACTIONS`. |
| Feature flags | `SystemFlag{key @unique, value}` | `prisma/schema.prisma` | Reusable to gate the feature (for example `transcript.enabled`). |

### 2.3 Roles and permission checks

- Roles: `ROLES = ["admin","jcrc","cca_head","resident","scrc"]` (`src/server/api/services/roles.ts:60`). `GRANTABLE_ROLES = ["admin","jcrc","cca_head","scrc"]` (`:162`). `jcrc` and `scrc` are mutually exclusive.
- **There is no role or record for "JCRC Honorary General Secretary", "JCRC President" or "Master".** JCRC is a flat `jcrc` role string. See Q4.
- tRPC procedures (`src/server/api/trpc.ts`): `publicProcedure`, `protectedProcedure`, `identifiedProcedure` (non-null `userID`), `matricProcedure`, `roleProcedure(...allowed)`, `adminProcedure`, `roleManagerProcedure` (jcrc; admin always passes), `scrcProcedure`, `oversightProcedure` (jcrc or scrc, read-only).
- CCA-scope guard: `assertHeadsCca(db, {userID, roles}, ccaID)` in `src/server/api/services/ccaScope.ts`. It passes for a manager capability or a `CcaHead` row, and deliberately never trusts `roles.includes("cca_head")`. **All head-scoped transcript mutations must use this.**
- `computeCapabilities(roles)` (`services/roles.ts:1398`) is the server-computed capability set that drives `/admin`.
- Roster logic: `services/ccaRoster.ts` (`resolveRoster` merges `CcaHead` + `UserCCA`; ambiguity is surfaced, not guessed) and `services/ccaMembers.ts` (`addCcaMember`, `removeCcaMember`).

### 2.4 PDF, download and QR

- **No PDF library** in `package.json`. "Download PDF" in the prototype is `window.print()` with `@page { size: A4; margin: 14mm }`.
- QR: `qrcode.react` (used in `src/app/transcript/_components/VerifyQr.tsx` and `src/app/events/_components/MyCheckInQr.tsx`), `jsqr` for scanning.
- `@vercel/blob` for uploads, `resend` for email (`src/lib/email.ts`), a dependency-free client-side `.xlsx` writer (`src/lib/xlsx.ts`), CSV helper (`src/app/admin/_lib/csv.ts`).
- CSP (`next.config.js`) allows `font-src 'self' data:`. Any new external font origin needs a CSP edit.

### 2.5 An existing prototype

A transcript **specimen** already exists on `main` (PR #112, `feature/cca-transcript-demo`). Do not rebuild it; replace its data layer.

- `src/app/transcript/page.tsx`: fixed demo resident, amber "Preview of an upcoming feature" banner, not login-gated.
- `src/app/transcript/_components/`: `TranscriptDocument.tsx`, `VerifyQr.tsx`, `PrintButton.tsx`, `fonts.ts` (EB Garamond + a script font for signatures, with a SPECIMEN watermark).
- `src/lib/transcript/demoData.ts`: types `TranscriptEntry`, `Transcript`, `Signatory`, and `getTranscriptByCode`. Its header comment states the same blocker found here: `UserCCA` has no AY, position or history. It proposes a sign-off chain (CCA head → JCRC President → Master) and describes a signature as a recorded approval by an identified account, not an image.
- `src/app/verify/page.tsx` and `src/app/verify/[code]/page.tsx`: public (exempt in `src/app/_components/MatricGate.tsx`), `robots: noindex`, show the full record, never a bare "Verified" for a specimen.

**Difference from this feature's requirements:** the prototype models a per-entry "commitment level / hours per week" and a three-signature chain. The requirements here instead call for a role column, a CCA glossary, extra contributions, a volunteer-hours section and an awards section. Q2 asks which of the prototype's ideas to keep.

### 2.6 Other

- Routing is Next.js 14 app router with no route groups. Resident pages: `/profile`, `/ccas/my`. Head pages: `/cca/[ccaID]/{details,members,events,...}`. Admin: `/admin/*` (`AdminShell`, `AdminCapabilityContext`). tRPC routers are in `src/server/api/routers/` and registered in `src/server/api/root.ts`.
- UI: shadcn components in `src/components/ui`, Tailwind (emerald palette), react-hook-form + zod, sonner.
- **No tests, no test runner, no `typecheck` script, and no `prisma/seed.ts`** (`package.json` points at a file that does not exist). Seeding is via `scripts/remediation/*.mjs`. This affects the Phase 2 definition of done (Q9).
- Lint: `.eslintrc.cjs` (next/core-web-vitals + typescript-eslint type-checked). `prettier.config.js` only adds `prettier-plugin-tailwindcss`.
- Docs style: `docs/plans/<area>/NN-topic.md`. This spec lives at `docs/transcript/SPEC.md` as requested; it can be moved to `docs/plans/transcript/01-spec.md` to match (Q10).

### 2.7 What is missing (summary)

Per-AY membership history; per-membership role/title; per-AY CCA description; extra-contribution records; any volunteering data; any awards data; a JCRC Honorary General Secretary identity; a persisted transcript issue record with a verification code; resident-session gating on `/transcript`.

---

## 3. Reference transcript analysis

**Extraction failed.** pypdf, pdfminer and PyMuPDF are not installed on this machine, and the task rules forbid installing anything. The two reference PDFs were not read:

- `C:\Users\rkoh2\OneDrive\Desktop\Personal\Scholarship\Student Development Transcript.pdf`
- `D:\NUS\General\Y2S1 Transcript.pdf`

The layout in section 4 is therefore based on the requirements and on the existing prototype (`TranscriptDocument.tsx`), not on the PDFs. It should be compared against the NUS document by the user before Phase 2 (Q11). General traits assumed for an NUS-style record: formal serif typography, issuer crest and title, student identification block, itemised tables grouped by period, a glossary of descriptions, an issue date, a validity/verification note and an end-of-document marker.

---

## 4. Proposed transcript layout

Page order, one AY per transcript in Phase 2:

1. **Header block:** hall crest, "Raffles Hall — Co-Curricular Transcript", resident name, matric (masked option, see feature H), residency period, AY, issue date, verification code + QR.
2. **Involvements table:** columns `CCA | Category | Role | Period`. `Role` is blank for plain members; a leader shows the stored title (Head, President, Leader). Extra contributions render as an indented sub-row under the CCA: "Contribution: <text>".
3. **CCA descriptions (glossary):** only the CCAs listed above, alphabetical. A CCA with no description shows a neutral line (see 7.2), never an empty heading.
4. **Volunteer Hours:** two tables, *Regular* (grouped by CCA) and *One-off* (activity, date, hours, verified by), with a total.
5. **Awards:** Colours Awards entries with citation. Omitted entirely, or "No awards recorded", per Q6.
6. **Footer:** issuer statement, verification URL, "End of transcript", page numbers.

```text
+--------------------------------------------------------------+
|  [crest]   RAFFLES HALL, NATIONAL UNIVERSITY OF SINGAPORE    |
|            CO-CURRICULAR TRANSCRIPT                          |
|                                                              |
|  Name:  TAN WEI MING            Matric:  A0******X           |
|  Academic Year: AY2025/26       Issued:  30 Apr 2026         |
|                                          [ QR ]  RH-7K3Q-9X2M |
|--------------------------------------------------------------|
|  1. INVOLVEMENTS                                             |
|  CCA                     Category        Role                |
|  Soccer (Male)           Sports          Captain             |
|  Hall Orchestra          Arts            -                   |
|    Contribution: Arranged the Dinner & Dance medley.         |
|  Welfare Committee       Service         -                   |
|--------------------------------------------------------------|
|  2. CCA DESCRIPTIONS                                         |
|  Hall Orchestra   Raffles Hall's instrumental ensemble ...   |
|  Soccer (Male)    Description not yet provided.              |
|  Welfare Committee Description not yet provided.             |
|--------------------------------------------------------------|
|  3. VOLUNTEER HOURS                                          |
|  Regular   Welfare Committee - Weekly food distribution  32h |
|  One-off   Freshmen Orientation helper (12 Aug 2025)      6h |
|                                           TOTAL           38h|
|--------------------------------------------------------------|
|  4. AWARDS                                                   |
|  Colours Award - Service Excellence (AY2025/26)              |
|--------------------------------------------------------------|
|  Verify at <origin>/verify/RH-7K3Q-9X2M      -- End --  1/1  |
+--------------------------------------------------------------+
```

Tone: third person, factual, no superlatives. Resident-written text is limited to what heads/exco enter; there is no free-text from the resident.

---

## 5. Proposed data model

Prisma-style snippets only. **`prisma/schema.prisma` is not modified.** All models are new sidecar collections (MongoDB, `@db.ObjectId` ids as in the existing schema), key on canonical `userID` (I-1), and use nullable fields or defaults (I-2). Indexes would be created via a `scripts/remediation/*.mjs` script, not `db push`.

### 5.1 Academic year

No model. Use a validated string `academicYear` of the form `"AY2025/26"` (same shape as the prototype), with one helper `currentAcademicYear(date)` (AY starts 1 August). Rationale: avoids a collection that must be seeded; semester-level breakdown (feature G) can add a nullable `semester Int?` later.

### 5.2 Role per CCA membership: `CcaMembershipRecord` (new)

Why new: `UserCCA` has no year/role/history and cannot be extended (validated, deletes on leave). `CcaHead` is "current only".

```prisma
model CcaMembershipRecord {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  userID       String                 // canonical (I-1)
  ccaID        Int
  academicYear String                 // "AY2025/26"
  position     String?                // null = plain member; "Head" | "President" | "Leader" | free-text title
  isLeadership Boolean  @default(false)
  source       String?                // "snapshot" | "head" | "import"
  createdAt    DateTime @default(now())
  createdBy    String?
  updatedAt    DateTime? @updatedAt
  updatedBy    String?

  @@unique([userID, ccaID, academicYear])
  @@index([ccaID, academicYear])
}
```

How it is populated (Phase 2/3): a one-off snapshot of current `UserCCA` + `CcaHead` into the current AY, then kept in sync by `addCcaMember`/`removeCcaMember`/head-grant code paths, plus head edits for position text. Past AYs cannot be reconstructed from existing data (no history); see Q5.

Position vocabulary: free-text with suggested values, or an enum. Recommendation: free text with a suggestion list, because 75+ CCAs use different titles (Captain, Chairperson, Director).

### 5.3 CCA description per AY

Options:

- **A. Reuse `CcaProfile.description`, resolve at render time.** Zero new storage. Descriptions change over time, so an old transcript re-rendered later would show new text.
- **B. A. plus snapshot into `TranscriptIssue` at issue time (recommended).** The issued transcript freezes the description it was issued with. Missing descriptions are handled at render (7.2).
- **C. Per-AY description collection.** Only needed if a CCA wants a different blurb each year. Adds work for heads who already struggle to fill one.

```prisma
// Recommended: no new description model. Description comes from CcaProfile.description,
// and is copied into TranscriptIssue.snapshot (5.7) when a transcript is issued.
```

### 5.4 Extra contribution: `ExtraContribution` (new)

```prisma
model ExtraContribution {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  userID       String
  ccaID        Int
  academicYear String
  description  String                 // free text, length-capped (suggest 300 chars)
  createdAt    DateTime @default(now())
  createdBy    String?                // head/exco who entered it
  updatedAt    DateTime? @updatedAt
  updatedBy    String?

  @@unique([userID, ccaID, academicYear])   // one per resident per CCA per AY (Q7)
  @@index([ccaID, academicYear])
}
```

Optional (Q7): a status field (`draft | published`) if heads want to stage entries before the transcript is generated.

### 5.5 Volunteer hours: `VolunteerRecord`

Three options for regular vs one-off:

| | A. One model with `kind` | B. Two models | C. Derive regular hours from events |
| --- | --- | --- | --- |
| Shape | `VolunteerRecord{kind: "regular"\|"one_off", ccaID?, hours, ...}` | `RegularVolunteerRecord` (CCA-bound, per-AY total) and `OneOffVolunteerRecord` (any resident, dated) | Sum `EventAttendance` for CCA events with a duration |
| Pros | One query, one UI, one audit path. CCA link optional so it fits both cases. | Cleaner type separation. | No data entry for regular hours. |
| Cons | Needs validation rules by `kind`. | Two of everything; the line between kinds is blurry (a one-off can happen at a CCA event). | `Event` has no end time or hours; attendance is per event, not per hour; misses non-event volunteering. Not a reliable source of truth. |

**Recommendation: A**, with an optional `eventID` so a record can reference an event without depending on it for hours. Option C can later pre-fill suggested hours.

```prisma
model VolunteerRecord {
  id            String   @id @default(auto()) @map("_id") @db.ObjectId
  userID        String
  academicYear  String
  kind          String   @default("one_off")   // "regular" | "one_off"
  ccaID         Int?                           // set for regular; optional for one_off
  eventID       Int?                           // optional link to Event
  title         String                         // activity description
  activityDate  DateTime?                      // one_off: date; regular: null
  hours         Float                          // > 0, capped (suggest <= 200 per record)
  status        String   @default("pending")   // "pending" | "verified" | "rejected"
  recordedBy    String?                        // who entered (head, JCRC, or resident)
  verifiedBy    String?
  verifiedAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime? @updatedAt

  @@index([userID, academicYear])
  @@index([ccaID, academicYear])
}
```

Only `verified` rows are printed. Who may submit and verify is in Q8 and 6.

### 5.6 Award: `Award` (new)

```prisma
model Award {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  userID       String
  academicYear String
  ceremony     String   @default("Colours Awards")
  title        String                 // e.g. "Service Excellence"
  category     String?
  citation     String?                // one or two lines
  enteredBy    String?                // the Honorary General Secretary (canonical userID)
  createdAt    DateTime @default(now())
  updatedAt    DateTime? @updatedAt
  updatedBy    String?

  @@index([userID, academicYear])
}
```

### 5.7 Issue record: `TranscriptIssue` (new, supports verification and snapshotting)

```prisma
model TranscriptIssue {
  id               String   @id @default(auto()) @map("_id") @db.ObjectId
  userID           String
  academicYear     String
  verificationCode String   @unique        // random, unguessable (not derived from userID)
  snapshot         Json                    // full rendered data incl. CCA descriptions at issue time
  issuedAt         DateTime @default(now())
  revokedAt        DateTime?
  revokedReason    String?

  @@index([userID, academicYear])
}
```

Phase 2 may skip persistence and render live, with the issue record added in Phase 3 (Q3).

### 5.8 Reused versus new

| Reused as-is | New |
| --- | --- |
| `User`, `UserMatric` (name, matric) | `CcaMembershipRecord` |
| `CCA` (name, category) | `ExtraContribution` |
| `CcaProfile.description` | `VolunteerRecord` |
| `CcaHead` (current head check via `assertHeadsCca`) | `Award` |
| `UserCCA` (source for the first snapshot only) | `TranscriptIssue` |
| `EventAttendance`, `Event` (optional hour suggestions) | |
| `RoleAuditLog` (new `AUDIT_ACTIONS`) | |
| `SystemFlag` (feature flag) | |
| Prototype pages, `VerifyQr`, `PrintButton`, fonts, `/verify` | |

---

## 6. Permission matrix

Rules: never trust the session roles for authorisation; re-read roles with `getUserRoles`. All writes append to `RoleAuditLog`. "Own CCA" is enforced with `assertHeadsCca`.

| Action | Resident | CCA head / exco (own CCA) | JCRC Honorary General Secretary | Admin |
| --- | --- | --- | --- | --- |
| View / download own transcript | Yes | Yes (own) | Yes (own) | Yes (own) |
| Preview own transcript before download | Yes | Yes | Yes | Yes |
| View another resident's transcript | No | Members' CCA rows only (no full transcript) | Read-only, any resident (Q12) | Yes |
| Set a member's position/role | No | Yes, own CCA | Override (Q12) | Yes |
| Create/edit/remove ExtraContribution | No | Yes, own CCA members | No | Yes |
| Edit CCA description (`CcaProfile`) | No | Yes (existing behaviour) | No | Yes |
| Submit one-off VolunteerRecord | Yes (as `pending`) | Yes, for own CCA members | Yes | Yes |
| Verify/reject VolunteerRecord | No | Regular + own CCA only | One-off, any | Yes |
| Create/edit Award | No | No | **Yes** | Yes |
| Revoke an issued transcript | No | No | Yes (Q12) | Yes |
| Verify a code at `/verify/<code>` | Anyone (public) | | | |

"Honorary General Secretary" does not exist as a role in code today. Options are in Q4. Exco: there is no exco concept in the schema; heads only. If exco should manage contributions, an exco marker is needed on `CcaMembershipRecord` (Q13).

---

## 7. Data flow

### 7.1 Assembling a transcript (one resident, one AY)

1. Request `/transcript?ay=AY2025/26` (default: latest AY with data). Gate: logged in with a non-null canonical `userID` (`identifiedProcedure`). The page shows only the signed-in resident's own data; no `userID` parameter is accepted.
2. Resolve identity: `User` (display name) and `UserMatric` (matric).
3. Load `CcaMembershipRecord` for `(userID, AY)`; join `CCA` for name and category; compute role text from `position` (blank when null).
4. Load `ExtraContribution` for `(userID, AY)`, group by `ccaID`.
5. Load `CcaProfile.description` for only those `ccaID`s.
6. Load verified `VolunteerRecord` for `(userID, AY)`, split by `kind`, total the hours.
7. Load `Award` for `(userID, AY)`.
8. Build a `Transcript` view-model (same module boundary as `src/lib/transcript/demoData.ts`: pages only call a data module, so swapping the demo for real data replaces the module, not the pages).
9. Render the page. Download = print-to-PDF (Phase 2). On "Issue", write `TranscriptIssue` with the snapshot and verification code (Phase 3).

### 7.2 Missing CCA descriptions

- `description` null or whitespace: show "Description not yet provided." in the glossary. Do not hide the CCA, because the glossary is an index of the involvement table.
- Admin/head nudge: a head dashboard counter "N of your CCAs lack a description" (feature M).
- Length cap: truncate at a sensible maximum with an ellipsis in print only, never silently in the stored value.

### 7.3 AYs with no data

- No membership records for the AY: show an empty state "No recorded involvements for AY2025/26" and disable download. Do not produce a blank formal document.
- Membership but no volunteering/awards: omit the section or print a single "None recorded" line, consistently (Q6).
- Before the first snapshot exists (past AYs): AYs earlier than the snapshot show no data; see Q5 for backfill.
- Unmatched or ambiguous membership rows (`resolveRoster` surfaces these): never guess. Show the row as-is in the head's management screen and exclude it from the transcript until fixed.

---

## 8. PDF generation options

No PDF library is in `package.json`; **nothing will be installed in Phase 1**.

| Option | Needs new dependency? | Pros | Cons |
| --- | --- | --- | --- |
| **1. Browser print-to-PDF** (what the prototype does: `window.print()` + `@page`) | **No** | Zero dependency; reuses `TranscriptDocument`; selectable text; fonts already via `next/font`. | Output depends on the user's browser; no server-side file; harder to attach to email or store; user can edit nothing but headers/footers may appear. |
| 2. `@react-pdf/renderer` | Yes | Server-side deterministic PDF; can email or store it; no headless browser. | New dependency; layouts must be re-done in its primitives (not reusing the Tailwind component); font embedding; bundle weight. |
| 3. `pdf-lib` / `pdfkit` | Yes | Fine control, small. | Imperative layout code; harder to maintain tables and pagination. |
| 4. Headless Chromium (Puppeteer/Playwright) | Yes | Pixel-matches the HTML. | Heavy on Vercel serverless; cold starts and size limits; operational risk. |

**Recommendation:** Phase 2 uses option 1 (existing code, no dependency, fastest path to a demonstrable slice). Revisit option 2 in Phase 3 if the hall needs server-generated, storable or emailed PDFs; that requires explicit approval to add a dependency (CLAUDE.md restriction). Hosting appears to be Vercel (per `docs/DeveloperGuide.md`), which argues against option 4.

---

## 9. Phased implementation plan

### Phase 2: working slice (seeded data, PDF download)

Goal: a resident with seeded data can open `/transcript`, see their own transcript, and print/save it as PDF.

1. Reconcile `/transcript` with real data: gate on the session, read the resident's own `userID` only, remove the amber "preview" banner for real data (keep the SPECIMEN mode for a demo route).
2. Add the data module behind the existing page boundary, returning the view-model of 7.1.
3. New models limited to what the slice needs: `CcaMembershipRecord` and `ExtraContribution` plus read-only VolunteerRecord/Award for display. **Schema changes need explicit approval first** (CLAUDE.md "Restrictions"); index creation via a `scripts/remediation/*.mjs` script.
4. Seed data via a local-only script (there is no `prisma/seed.ts`; Q9). Local database only.
5. Layout: involvements table with role column, glossary with missing-description handling, volunteer and awards sections, empty states.
6. Download: print CSS and a Download/Print button (reuse `PrintButton`).
7. Feature flag `transcript.enabled` in `SystemFlag`.
8. Definition of done (CLAUDE.md): lint, typecheck and tests pass. As there is no test runner or `typecheck` script today, Q9 asks how to meet this.

### Phase 3: management flows, volunteering and awards

1. Head screens under `/cca/[ccaID]/transcript`: set positions, manage extra contributions; guarded by `assertHeadsCca`.
2. Volunteer hours: resident submit form (one-off), head submit/verify (regular), JCRC verify.
3. Awards: Honorary General Secretary entry screen under `/admin`, with the capability added to `computeCapabilities` (depends on Q4).
4. `TranscriptIssue` persistence, verification code, `/verify/<code>` switched from specimen to real records, revoke flow.
5. Audit: new `AUDIT_ACTIONS` for every write.
6. Resident preview-before-download and history of issued transcripts.
7. Selected extras from section 11.

---

## 10. Risks and open questions

Answerable pick-one or yes/no.

1. **Database mismatch.** `CLAUDE.md` says Postgres, but `prisma/schema.prisma` uses MongoDB and `start-database.sh` starts a Postgres container (its container name even includes a local path). Which is the real target for local dev: (a) MongoDB as in the schema, or (b) Postgres as in `CLAUDE.md`?
2. **Prototype scope.** The existing specimen shows commitment level, hours per week and a three-signature chain (head → JCRC President → Master). Keep which: (a) the requirements here only, (b) requirements plus the signature chain, or (c) requirements plus commitment level?
3. **Persist at issue?** Should a transcript be frozen as a stored snapshot when issued (verifiable, stable), or always rendered live? (a) snapshot at issue (recommended), (b) live only.
4. **Honorary General Secretary identity.** There is no such role. (a) add a new grantable role, (b) a new `JcrcPosition` sidecar record naming office-holders per AY with `jcrc` as the base role, or (c) any `jcrc` user may enter awards? Adding a role changes `ROLES`/`GRANTABLE_ROLES` and needs sign-off.
5. **History.** `UserCCA` has no past years, so past AYs have no data. Is it acceptable that (a) transcripts only exist from the current AY onward, or (b) should heads backfill past AYs via a CSV import?
6. **Empty sections.** For no volunteering or no awards, (a) omit the section or (b) print "None recorded"?
7. **Extra contribution.** One per resident per CCA per AY, or several? Should it have a draft/publish status?
8. **Who may log one-off volunteering?** (a) any resident self-reports and a JCRC verifies, (b) only a head/JCRC records it, (c) resident self-report with no verification but labelled "self-reported".
9. **Definition of done.** The repo has no test runner or `typecheck` script. For Phase 2, (a) add a test runner (needs approval to add dependencies), (b) rely on `npm run lint` + `tsc --noEmit` only, or (c) manual verification with seeded data?
10. **Doc location.** Keep this at `docs/transcript/SPEC.md` or move to `docs/plans/transcript/01-spec.md` to match existing plans?
11. **Reference PDFs.** Text extraction was not possible here. Can you confirm the NUS layout (sections, wording) matches section 4, or install a PDF reader for me to use?
12. **JCRC Honorary General Secretary powers.** Should they also be able to revoke issued transcripts and view any resident's transcript read-only?
13. **Exco.** Does "exco" mean (a) people the head designates inside the app (new marker) or (b) just heads? Heads and exco may manage extra contributions; today only heads exist in the schema.
14. **Privacy default.** Should matric be shown fully, masked (A0\*\*\*\*\*X), or at the resident's choice?
15. **Role titles.** Free-text titles (recommended) or a fixed list (Head, President, Leader)?

Risks: (R1) wrong or incomplete membership data produces an "official" document that is wrong, mitigated by only printing recorded/verified facts and by the audit log; (R2) heads not filling in data, mitigated by empty states and nudges; (R3) legacy `$jsonSchema` collections silently reject writes, mitigated by sidecars only; (R4) mixed `userID` formats (A-format vs canonical) can split a resident's history, mitigated by canonicalising on write and read; (R5) a public `/verify` page exposes personal data, mitigated by unguessable codes, `noindex`, and revocation; (R6) print-to-PDF output varies by browser.

---

## 11. Suggested extra features

Effort: S = small, M = medium, L = large.

| # | Feature | Effort | Notes |
| --- | --- | --- | --- |
| A | **Verification QR / code** with public `/verify/<code>` (prototype exists; switch to real records, add revoke) | M | Needs `TranscriptIssue`. |
| B | **Resident preview before download** (watermarked "Draft" until issued) | S | Same renderer. |
| C | **Co-curricular summary page** (counts: CCAs, leadership roles, hours, awards) | S | Derived data only. |
| D | **Multi-AY cumulative transcript** (all years on one document) | M | Requires per-AY history (Q5). |
| E | **Head/exco nomination workflow** for extra contributions (exco nominates, head approves) | M | Needs status field and exco marker. |
| F | **Hours totals and milestone badges** (for example 50/100/200 hours) | S | Computed from verified hours. |
| G | **Semester-level breakdown** | M | Add `semester Int?`. |
| H | **Privacy controls** (mask matric, hide sections) | S | Resident-side toggles. |
| I | **Export formats** (server-side PDF, CSV of records, `.xlsx` via `src/lib/xlsx.ts`) | M | Server PDF needs a dependency. |
| J | **Audit log of edits** (who changed a position, contribution or award) | S | Reuse `RoleAuditLog`; add actions. |
| K | **Email the transcript** to the resident via `src/lib/email.ts` | S | Needs a stored PDF or link. |
| L | **Bulk entry** of awards and positions via CSV/XLSX import, like `BulkRoleImport` | M | Reuse the existing wizard pattern with dry-run preview. |
| M | **Head dashboard completeness nudge** ("3 of 5 members missing positions", "CCA has no description") | S | Query only. |
| N | **Event-based hour suggestions** from `EventAttendance` for CCA events | M | Suggestion only, not the source of truth. |
| O | **Transcript request/approval window** (open at end of AY, close after) via `SystemFlag` | S | Reuses the flag pattern. |
| P | **Linking applications to history**: accepted `CcaApplication` seeds membership records | M | Existing acceptance writes `UserCCA`. |
| Q | **Accessibility and print QA** (screen-reader tables, A4 pagination checks) | S | Print CSS already exists. |

---

## 12. Phase 2 decisions

These supersede anything above that conflicts.

- **Removed from the prototype:** commitment level, hours-per-week badge, per-entry "certified by" signature, the JCRC President / Master signatures, and the signature script font. The verification code, QR and `/verify/<code>` page are kept.
- **Awards editor:** roles `jcrc` or `admin`. There is no Honorary General Secretary role in the app; `src/server/api/services/roles.ts` is not modified. (Resolves Q4.)
- **No backfill:** transcripts start at AY2026/27 (resolves Q5). AY strings use the form `AY2026/27`.
- **No schema change in Phase 2:** the future collections are represented as TypeScript input types in `src/lib/transcript/types.ts`. The sidecar models in section 5 remain the target for a later phase and still need approval.
- **Layout order:** header and resident details (with verification code and QR), co-curricular involvements, CCA descriptions, volunteer hours (omitted if none), awards (omitted if none). An empty year shows "No recorded involvements for this academic year."
- **Missing CCA description:** shown as the muted text "Description not yet available."
- **Data-driven sections:** the document renders an ordered list of sections from the assembler, so a JCRC service section and a testimonial block can be added in Phase 3 without redesign. Neither is built yet.
- **PDF:** Phase 2 uses the browser's print-to-PDF ("Save as PDF" calls `window.print()`) with an A4 print stylesheet. No PDF library was added.
- **Tests:** Vitest is the only new dependency (devDependency). `@vitest/coverage-v8` is not installed, so coverage is unmeasured.
- **Preview:** `/transcript/preview/[fixture]` shows each of the 10 specimens in development and returns 404 in production. The `/transcript` and `/verify` pages still render specimens only; they are not yet tied to the signed-in resident.

---

## 13. Template C decisions

Built on top of upstream PR #113 (one transcript per academic year, `?ay=`, one verification code per year). These supersede anything above that conflicts.

- **Look:** formal and plain. Black text on white, Arial, thin rules, tables, no accent colour. The only colour on the page is the Raffles Hall crest, shown top left on every page (main, JCRC, notes) and on `/verify`. A faint paper hatch shows on screen only and is removed in print.
- **Pages, in order:** page 1 (header, QR, resident row, I. Leadership and CCA participation, II. Volunteer hours, III. Awards); the JCRC page (JCRC members only, always on a new printed page); the Explanatory notes page (numbered footnotes, "About this record", end marker). Empty sections are omitted. An empty year shows "No recorded involvements for this academic year."
- **Per-year records:** each year has its own issue (its academic year and issue date). Faculty, block and year of residence are not shown.
- **JCRC:** one `JcrcServiceInput` per resident, applied only to the year in its `term`. The JCRC appointment is the first row of the table and is counted as a leadership role, not as a CCA. All JCRC content is placeholder data.
- **Signatures:** never data. The JCRC page always prints two empty boxes labelled "[Master signature placeholder]" and "[President signature placeholder]", each with a date placeholder, and never a person's name.
- **Footer:** where the browser supports `@page` margin boxes (Chrome 131 or later) the footer is two margin boxes on one baseline: the resident name and matric at the left (written into the stylesheet as CSS hex escapes of every character, so a name can never inject markup) and "Page X of Y", counted by the browser, at the right. Elsewhere the name and matric are a plain `position: fixed` element pinned to the bottom of the content area, so every browser repeats it on every printed page, with no page numbers; it is switched off by `@supports (interpolate-size: allow-keywords)` where the margin boxes work, so the name is never printed twice. Each sheet ends in a repeating empty table footer that reserves the space, so body text never prints under it. On screen each page shows its own footer.
- **Summary strip removed:** the four-cell strip (CCAs, leadership roles, volunteer hours, awards) that sat on page 1 was removed at the user's request, along with the assembler code that fed it.
- **Continued pages:** the page header (crest and title) sits in a table head, so it repeats on every printed page a page runs onto.
- **Page references:** the table says "See the Junior Common Room Committee page" rather than "See page 2", because page 1 can run to several printed pages for a resident in many CCAs.
- **Notes order:** footnotes follow the table (JCRC row, then leaders, then members alphabetically), not alphabetical order.
- **Single fixture source:** `src/lib/transcript/fixtures.ts` replaces `demoData.ts`. It holds twelve specimens, including a JCRC Sports Secretary (two years) and a JCRC member with no other CCAs.
- **Vitest 3, not 5:** `npm ci` fails with vitest 5 because of its optional `@types/node@22+` peer against the repo's `@types/node@20`. Vitest 3 resolves cleanly, and the lockfile diff against `upstream/main` is additions only.

---

## 14. Phase 3 data model

Decisions are locked in `CLAUDE.md` ("Data model decisions"). All models live in `prisma/schema.prisma` as NEW, UNVALIDATED collections, keyed on the canonical `userID` and the `ccaID` business key; key fields are required, every other scalar is nullable or defaulted (I-2). `CCA`, `UserCCA` and `User` are untouched (they are validator-guarded and silently reject new fields).

**How it works.** Membership is read LIVE from `UserCCA` and `CcaHead` and FROZEN into `TranscriptIssue.snapshot` when an admin/JCRC publishes an academic year. A member who left is simply not on the transcript. The app has no notion of a term or semester, so `TranscriptPeriod` adds it. Hall points are a separate, future system and out of scope.

| Model | Key | Fields |
| --- | --- | --- |
| `TranscriptPeriod` | `academicYear` (unique, "AY2026/27") | `sem2Start`, `status` (collecting | published, default collecting), `publishedAt/By`, `reopenedAt/By` |
| `TranscriptRosterEntry` | unique (`academicYear`, `userID`, `ccaID`) | `duration` (full | sem1 | sem2), `roleLabel`, `roleDuration` (full | sem1 | sem2), `extraContribution`, `frozen` (default false), `updatedBy`, `updatedAt` |
| `VolunteerRecord` | index (`academicYear`, `userID`) | `ccaID` (the volunteering CCA that recorded it), `kind` (regular | oneoff), `activity`, `activityDate`, `hours`, `recordedBy`, `recordedAt`, `voidedAt` |
| `Award` | index (`academicYear`, `userID`) | `title`, `citation`, `ceremony` (default "Colours Awards"), `recordedBy`, `recordedAt`, `voidedAt` |
| `JcrcService` | unique (`academicYear`, `userID`) | `portfolio`, `position`, `description`, `contributions[]`, `testimonial`, `isPlaceholder` (default true), `updatedAt` |
| `TranscriptIssue` | `code` (unique, random) | `academicYear`, `userID`, `issuedAt`, `snapshot` (Json), `revokedAt`, `revokedBy` |

**The one change to an existing model:** `CcaProfile.isVolunteering Boolean?`, set by admin/JCRC. The heads of a tagged CCA (the four "RVC ..." CCAs) may record volunteer hours for any resident.

**Durations.** The default duration comes from `CcaApplication.decidedAt` against `TranscriptPeriod.sem2Start` (decided before: full; after: sem2). A head may override it. Roles can also be sem1, sem2 or full. The transcript prints a duration only when it is not a full year.

**Status.** collecting (heads/JCRC edit; residents cannot download) -> published (residents download; edits locked). Admin and JCRC control it and may reopen.

**Never deleted.** Volunteer records and awards are voided, and issued transcripts are revoked, so the audit trail survives.

This phase adds the models, a local database and a seed only. Loaders, permission gates and screens come next.

---

## 15. Phase 3c server logic

Code: `src/server/api/services/transcript/{periods,loader,issue}.ts` and the `transcript` tRPC router (`src/server/api/routers/transcript.ts`, registered in `root.ts`). Services take the Prisma client as a parameter. Nothing here writes CCA, UserCCA or User. No UI yet.

**Procedures**

| Procedure | Who | What |
| --- | --- | --- |
| `periods.list` | admin, jcrc | All periods, plus the current academic year |
| `periods.setSem2Start` | admin, jcrc | Set or clear the semester-2 start date (must fall inside the year; refused once published) |
| `periods.publish` | admin, jcrc | Freeze the roster and open the year to residents |
| `periods.reopen` | admin, jcrc | Back to collecting; supersedes issued transcripts |
| `preview` | admin, jcrc | One resident's transcript: frozen if published, live if not. Never creates an issue |
| `mine.get` | any signed-in resident | Their own transcript, or `{status: "not_open"}` while collecting |
| `verify` | public, rate limited | valid / revoked / superseded / not_found, matric masked |

Builders: `roleManagerProcedure` (admin + jcrc; scrc is stopped here) plus a live `getUserRoles` re-check (I-5), `identifiedProcedure` for `mine.get`, `publicProcedure` for `verify`. `verify` uses the repo's `rateLimit` and `clientIp` (`src/lib/rateLimit.ts`): 30 requests per 10 minutes per client address.

**Publish.** Needs the period to exist and `sem2Start` to be set. In one transaction it claims the status (compare-and-set, so two concurrent publishes cannot both win), clears old freeze flags, then writes a frozen entry for every LIVE member, resolved through the same roster resolver the head screens use (UserCCA under either key format, the embedded `User.userCCA` array, and CcaHead). Rows that cannot be resolved to one person are counted and skipped, never guessed at. For each member:

- `duration` = the stored override, else `sem2` if their accepted application was decided on or after `sem2Start`, else `full`.
- `roleLabel` = the stored override, else `Head` if they hold a CcaHead row.
- `roleDuration` = the stored override, else (for a head) `sem2` if granted on or after `sem2Start`, else `full`.

Members who have left get no entry. After publish the loader reads only frozen entries, so someone who leaves later still appears and someone who joins later does not.

**Issue.** A resident gets a transcript only once the year is published, only their own (identity comes from the session; there is no userID input). It is idempotent, including under concurrent requests. The code is `RH-` plus 16 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` via `crypto.randomBytes` with rejection sampling. `snapshot` stores the issued view model.

**Reopen.** Sets the year back to collecting and clears nothing. Every unrevoked issue of the year gets `revokedAt` and `revokedBy` set and `snapshot.meta = { superseded: true, reason: "Academic year reopened" }`. That is how `verify` tells superseded from revoked: the schema has no dedicated field and was not changed. A resident gets a new transcript after re-publish.

**Errors** are `TRPCError` messages: `PERIOD_NOT_FOUND`, `ALREADY_PUBLISHED`, `NOT_PUBLISHED`, `SEM2_START_REQUIRED`, `SEM2_START_OUTSIDE_YEAR`, `PERIOD_PUBLISHED` (from `assertCollecting`, for the later edit screens), `PERIOD_CHANGING` (lost a race), `INVALID_ACADEMIC_YEAR`, `INSUFFICIENT_ROLE`, `RATE_LIMITED:<seconds>`.

**MongoDB gotcha, handled.** Prisma's `where: { field: null }` does not match a document where the field is absent, which is how `create` stores an omitted nullable field. Every "not voided / not revoked" query therefore uses `NOT_VOIDED` / `NOT_REVOKED` (null OR unset) from `loader.ts`.

**Block and year of residence.** Removed (section 32): the app keeps no residence history, and the header no longer shows either.

---

## 16. Phase 3d resident pages

`/transcript` and `/verify` now show real data. Specimens remain only at the development-only `/transcript/preview/[fixture]` (404 in production), and the SPECIMEN watermark appears only when the data is a fixture.

**`/transcript`** (signed in)
- Gated like the repo's other server pages: `auth()` then `redirect("/login")`. The identity comes only from the session; `mine.get` takes no userID.
- `mine.years` (new, names only) lists the published academic years. `?ay=2026-27` picks one; a missing, invalid or unpublished value falls back to the latest published year and never errors. Logic: `src/lib/transcript/pageState.ts`.
- With no published year, a calm page: "Your transcript for <current AY> isn't available yet." and "It opens once the hall publishes transcripts." No dates are promised.
- A published year issues on first visit (idempotent) and renders the STORED SNAPSHOT, never a recomputation, so it is exactly what `/verify` shows. A resident with no involvements gets the empty-year document and still receives a code.
- The Save-as-PDF button, QR, crest and footers are unchanged. The `/profile` page already linked to `/transcript`; only its label changed (from "CCA Transcript (preview)" to "Transcript").

**`/verify` and `/verify/<code>`** (public, no login, `noindex`)
- `transcript.verify` decides (rate limited per client address); the page renders the answer. valid: "This record is valid." plus the document from the snapshot with the matric masked. superseded: a prominent plain note, "This record has been superseded by a later version. Ask the resident for the current transcript.", plus the document. revoked: only "This record has been revoked." Unknown, malformed or oversized codes: "We could not verify this code. Check it for typing mistakes." Rate limited: "Too many attempts. Try again later." Nothing else is revealed: no resident list, no year list, no near matches.
- Development only: a made-up specimen code still renders its specimen, so the preview's "see what a verifier sees" link works. In production only real issued codes verify.

**No hard-coded domain.** The notes page prints the site's own address, taken from the request host (so a preview deploy prints its own) with `NEXTAUTH_URL` as the fallback, or words around it ("the verification page of this site") when neither is usable. A test scans the sources to keep it that way.

**Print.** Real issued transcripts were printed from `/verify/<code>` with headless Chrome: a plain member is 2 pages and a JCRC member 3, with the crest, the page footer and the (masked) name on every page, and no SPECIMEN text.

---

## 17. Phase 3e management API

Router `transcriptManage` (`src/server/api/routers/transcriptManage.ts`, registered in `root.ts`), services in `src/server/api/services/transcript/manage*.ts` and `residents.ts`, input rules in `src/lib/transcript/manageInput.ts`. No UI yet. Opening, publishing and issuing stay in the `transcript` router (section 15).

**Who.** Every check reads LIVE roles (I-5), never the session copy.
- **manager** = admin or jcrc (`roleManagerProcedure` plus a live re-check).
- **head or manager** = a live CcaHead row for THAT CCA (`assertHeadsCca`), or a manager. The scope-free `cca_head` role string is never used. The head of another CCA, and a plain resident, get FORBIDDEN.
- **JCRC member** = the live `jcrc` role, for their own record only. Admin alone does not qualify.
- hall office (`scrc`) and residents get nothing here.

**AY rule.** Every write to a year's data needs the year to be `collecting`; once `published` it fails with `PRECONDITION_FAILED: PERIOD_PUBLISHED`, and works again after a reopen. Reads are always allowed.

| Procedure | Who | AY status rule |
| --- | --- | --- |
| `ccaTags.list` | manager | any |
| `ccaTags.setVolunteering` | manager | any (the tag belongs to no year); touches only `isVolunteering`, `updatedAt`, `updatedBy` on CcaProfile |
| `awards.list` | manager | any |
| `awards.create` | manager | collecting only; the resident must exist |
| `awards.void` | manager | collecting only; sets `voidedAt`, never deletes |
| `jcrc.saveFor` | manager | collecting only; any existing resident |
| `jcrc.mine` | JCRC member (own) | any |
| `jcrc.saveMine` | JCRC member (own) | collecting only; `isPlaceholder` stays true |
| `residents.search` | manager | n/a. 3+ characters, at most 10 hits of `{userID, displayName, matric}` |
| `roster.list` | head of this CCA, or manager | any: live while collecting, frozen once published. Shows each default beside any override |
| `roster.upsert` | head of this CCA, or manager | collecting only; the user must be a current member; null or blank clears an override |
| `volunteer.list` | head of this CCA, or manager | any |
| `volunteer.create` | head of this CCA, or manager | collecting only; the CCA must be tagged `isVolunteering` (managers too); any existing resident; a one-off needs a date inside 1 Aug to 31 Jul; hours 0.25 to 200 in quarters |
| `volunteer.void` | head of the record's CCA, or manager | collecting only; sets `voidedAt`, never deletes |

**Text.** Plain text, trimmed, length-bounded, control characters rejected (a newline is allowed in the multi-line fields only: description, testimonial, extra contribution). Limits: award title 120, citation 300; role label 60, extra contribution 500; activity 120; JCRC portfolio and position 80, description 800, up to 10 contributions of 200, testimonial 1500.

**Actors.** Since Phase 3f, `voidedBy` (awards, volunteer records) and `updatedBy` (JCRC records) are stored beside the time; they hold the canonical userID of the signed-in actor.

**Resident search.** No reusable helper existed (the admin search lives inside `admin.listUsers` and returns far more), so a minimal manager-only one was written. It escapes regex characters and returns no email or roles.

**Dev logins.** Seeded residents can now sign in locally (`docs/transcript/DEV-SETUP.md`).


## 18. Phase 3f admin screens

Route `/admin/transcripts`, for admin and jcrc only. Gate: the admin layout, then `src/app/admin/transcripts/layout.tsx`, which re-reads the roles live and redirects anyone else to `/admin` (signed out: `/login`); every procedure behind the screens checks the role again. The "Transcripts" tab is shown by the `manageCcaHeads` capability, which equals admin or jcrc (a DB test keeps it in step with `canManageTranscriptPeriods`).

1. **Academic year.** Status, semester 2 start date, publish and reopen, each behind a confirmation dialog stating the consequence. The date is typed as a calendar date and stored as midnight Singapore time (`2027-01-12` is `2027-01-11T16:00Z`); the roster screen shows it back as the same date. Publish reports "N members frozen, M rows could not be matched".
2. **Volunteering CCAs.** One switch per CCA bound to `ccaTags.setVolunteering`, with a filter.
3. **Awards.** Add and void for a chosen year; locked once the year is published; voided awards hidden unless asked for.
4. **Preview as a resident.** `/admin/transcripts/preview/[userID]?ay=2026-27` renders the live Template C document with the "Preview. Not issued." bar. It never creates an issue. Printing from it includes the admin chrome.

Errors are inline red `role="alert"` lines (the app mounts no toaster). Resident search is the minimal manager-only `residents.search`; matric is shown in search results only.

## 19. Phase 3g head and JCRC screens

**CCA head tab.** `/cca/[ccaID]/transcript`, one entry ("Transcript") in the CCA dashboard navigation. There is no page-level guard, like the sibling sections: every call is `roster.list`, `roster.upsert` or `volunteer.*`, which require the head of THIS CCA or a manager, so the head of another CCA sees the shell and then "You do not head this CCA". A plain resident never reaches `/cca` (the layout sends them home).

- **Member roster.** One row per current member for the chosen year: Duration (Default, Full year, Semester 1 only, Semester 2 only, with the computed default in the first option's label), Role (blank means member; a current head's placeholder shows the default), Role period (shown when a role is typed or the member is a current head), Additional contribution (500 characters, counter). Each row saves on its own, and Save is enabled only for a changed row. Blank or "Default" clears the override. Limits: role 60, contribution 500.
- **Notes.** A published year shows "Transcripts for AYxxxx/xx are published. Editing is closed. Ask the JCRC to reopen it." and every field is read-only. While the semester 2 start date is unset: "Default durations assume the full year until the JCRC sets the semester 2 start date." An empty CCA description links to the CCA details form.
- **Volunteer hours.** Only when the CCA is tagged `isVolunteering` (the flag now comes back on `roster.list`); other CCAs render nothing. Resident search (3+ characters, debounced), kind, activity (120), a date for a one-off (inside 1 August to 31 July), hours (0.25 to 200 in quarters). Records list with who recorded each, a confirmed Void, and total hours per resident.
- **Matric.** Shown only in the resident search results; hidden once a resident is chosen and never rendered in the roster or the records.

**Resident search** (`residents.search`) now admits a manager or the head of at least one volunteering CCA (live `CcaHead` joined to `CcaProfile.isVolunteering`); anyone else gets `NOT_A_VOLUNTEERING_HEAD`. It still returns only `{userID, displayName, matric}`.

**JCRC self page.** `/admin/transcripts/jcrc`, linked from the top of `/admin/transcripts` (no second navigation entry). Fields: portfolio (80), position (80), what the role covers (800), up to 10 contributions of 200, testimonial (1500), saved with `jcrc.saveMine`. An admin without the live `jcrc` role gets `JCRC_MEMBER_REQUIRED` and the page says "Only JCRC members have a JCRC page." The page states that the Master and President signatures are placeholders, links "Preview my transcript" to the existing preview, and is read-only when the year is published.

**Small fixes.** Awards and volunteer records show who recorded them by display name (`recordedByName`, `voidedByName`), falling back to the key. The preview page prints as the clean Template C transcript: the admin header and tab bar are hidden in print (the rules are raw CSS in a `<style>` tag; React escapes `>` in a style's text children, which silently broke the first attempt).

**Known limits.** `roster.list` and `volunteer.list` still return each member's matric in the payload; the screens never render it. The seeded accounts have incomplete profiles, so in a real browser the app's profile gate sends them to `/profile` until the profile is completed.

## 20. Phase 3h hardening

- **Seeded accounts** now carry a fake Telegram handle, so the app's profile gate (display name, Telegram, block, matric) passes and a browser no longer redirects them to `/profile`.
- **Matric minimisation.** `roster.list`, `volunteer.list` and `awards.list` no longer return a matric. `residents.search` returns `{userID, displayName, maskedMatric}`, the mask keeping the first character and the last three (`maskMatricForSearch`). A head of a volunteering CCA who is not a manager searches by display name only (matching email or matric would let repeated queries confirm a masked matric). The search is limited to 60 requests per signed-in user per 10 minutes (`TOO_MANY_REQUESTS`, `RATE_LIMITED:<seconds>`).
- **Review fixes.** An impossible semester 2 date (for example 2027-02-30) is now refused instead of clearing the saved date. Publish re-reads the stored entries and the semester 2 date inside its transaction, after the status claim. An issue created while a year is being reopened is withdrawn. `/transcript` rethrows unexpected errors instead of showing "not available".
- **Cache headers.** In a production build `/transcript`, `/verify`, `/verify/[code]` and `/admin/transcripts` answer `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (Next's default for dynamic pages). No `next.config.js` change was made.
- **Known and left as is.** A superseded code still shows its snapshot.

## 21. Phase 3i review follow-ups

- **One valid issue per resident and year.** `TranscriptIssue.activeKey` is a required, unique string (index `issue_active_key`). A valid issue holds `<academicYear>|<userID>`. Reopening rewrites the key of every superseded issue, in the same write that sets `revokedAt`, to `<academicYear>|<userID>|revoked|<issue id>`, which frees the valid key. Issuing inserts with the valid key; a duplicate-key error means a concurrent first download won, so the existing valid issue is read and returned (idempotent). The key is never null or absent, because MongoDB unique indexes treat a missing value as a duplicate. Five parallel first downloads yield one row and one code.
- **Batched publish.** Frozen entries are computed in memory (after a re-read inside the transaction, following the status claim). Entries that take identical values are updated together with `updateMany`, new ones are created in chunks of 1,000. A synthetic hall of 2,000 memberships (400 residents in 5 CCAs, 400 annotated) publishes in about 2 seconds, against a 60 second transaction limit.
- **Invisible characters.** Every free-text field rejects U+200B-200F, U+202A-202E, U+2060-2064, U+2066-2069 and U+FEFF (`INVISIBLE_CHARACTERS_NOT_ALLOWED`).
- **Singapore dates.** Dates shown for the year panel (published on) use `formatSgDate`, a Singapore calendar date whatever the browser's zone. A one-off activity's own date is a stored calendar date (UTC midnight, unshifted); the fallback for a record without one is its recorded instant read in Singapore.
- **Forms.** After a save a row, the JCRC page and the semester 2 field keep showing the values the server stored and are no longer dirty; typing done while a save was in flight is kept and stays dirty. Add forms clear what was added and keep the year and kind. The JCRC form no longer reloads over unsaved typing.
- **Verify page.** The "Not on file" placeholder is no longer masked.
- **Index.** `VolunteerRecord` is indexed by `(ccaID, academicYear)` (`volunteer_cca_year`).
- **Production note.** Apply the schema (`prisma db push`) before the first publish: it creates the unique index on `TranscriptIssue.activeKey`. The collection has no rows in production, so no backfill is needed.

## 22. Click-through fixes and verification removal

This section supersedes every earlier mention of verification, issuing, snapshots, superseding and revoking (sections that describe them are history).

- **No verification.** The transcript is a recognition document, not a verified source of truth. Removed: `/verify`, the QR code, the verification code and its generator, `transcript.verify` and its rate limit, stored snapshots, and the superseded and revoked states. Reopening a year is a plain status change (it records who and when). The notes page closes with one sentence: "Generated from Raffles Hall's records."
- **Assembled from data on every view.** A published year's `/transcript` is built each time from the frozen roster entries plus the current activity, volunteer, award and JCRC records. "Date issued" is the day the year was published (Singapore date), the same on every view; an admin preview of an unpublished year says "Not yet issued".
- **TranscriptAccess** replaces TranscriptIssue: `{academicYear, userID, firstOpenedAt, lastOpenedAt}`, unique per year and resident (`access_year_user`), written by an upsert that survives a race (a duplicate-key error turns into an update) whenever a resident's transcript is returned. `transcript.mine.readiness` answers whether a published year has no such row for the signed-in user.
- **Entry point.** "My transcript" sits under "My applications" in the desktop profile menu and the mobile menu, with a "Ready" badge and a dot on the profile button while a published year is unopened. The link under My CCAs on the profile page is gone. A per-year **download by** date (a Singapore calendar date, stored as midnight Singapore time, editable even while published) shows a banner on `/transcript` through the end of that day.
- **Role period inside the membership.** The effective role period is the override or default, narrowed to the membership (a semester 2 member's role is never full-year). The editor offers only the fitting options and changes a role period that no longer fits, with "Role period changed to Semester 2 only to match membership." `roster.upsert` refuses an incompatible pair (`ROLE_PERIOD_OUTSIDE_MEMBERSHIP`). Publish and the loader clamp, so stored or seeded data can never render "Head (full year)" for a semester 2 member.
- **Year cell.** "2026/27", "2026/27 Sem 1" or "2026/27 Sem 2" on one line (the column is sized for it); a part-year role reads "Head (Sem 2)". The notes page gains "Sem 1 / Sem 2: involvement for that semester only." when any such item exists.
- **JCRC contributions** are structured rows `{activity (80, required), role (60), description (300)}`, with no visible row limit (a hidden cap of 200 per save), stored as a composite type on `JcrcService`. The editor has a card per row with counters, Move up / Move down, Remove (shown as "Removed. Undo" until Save) and a plain count ("2 contributions"). The JCRC page prints them as three aligned columns with no header row.
- **Volunteering CCAs page** lists only tagged CCAs (count line, Remove with confirmation, "No volunteering CCAs yet."), with a search (2+ characters) that suggests untagged CCAs to add.
- **Names, not keys.** publishedBy, reopenedBy, recordedBy and voidedBy are shown as display names, resolved on the server by one helper (`actorLabels`); the key appears only when no name exists.
- **Resident picker** is an ARIA combobox (combobox / listbox / option roles, `aria-activedescendant`, ArrowUp/Down, Home/End, Enter, Escape, results announced in the live line). Placeholder: "Name, email or matric" for managers, "Name" for heads.
- **Phones.** Under Save as PDF: "On a phone, use Share, then Print, then save as PDF." At 375 px the page has no horizontal scroll.
- **Roster header** cells are real table header cells (they had `display: block`).
- **Left as is.** `qrcode.react` stays in package.json (the events check-in uses it). The 60-second MongoDB transaction limit is no concern at hall scale (2,000 memberships publish in about 2 seconds).

## 23. Year lifecycle and handover freeze

CCA memberships are cleared and re-recruited after each CCA's handover, so freezing a whole year's member lists at publish time would capture the wrong people. Each CCA's list is frozen at its own handover instead. This section supersedes section 22's description of publish freezing the roster.

**Term year.** A CCA's term year is the earliest year, from AY2026/27 up to the year after the current one, in which it has no ACTIVE freeze. A CCA's head screen defaults to it, and memberships made after a handover therefore count toward the next year even before 1 August (`termAcademicYear`, pure and tested; every service takes an injectable `now`).

**Freeze record.** `CcaYearFreeze { academicYear, ccaID, reason, frozenAt, frozenBy, memberCount, unfrozenAt, unfrozenBy, unfreezeReason }`, unique per year and CCA (`freeze_year_cca`). Reasons: `handover`, `head_removed`, `lock`, `close_year`. ACTIVE means `unfrozenAt` is empty. A later freeze of the same year reuses the document (the unfreeze fields are cleared).

**`freezeCca`.** The target year is the CCA's term year, never later than the current one: if the term year is already ahead, nothing happens (`skipped`). Refused if the target year is published. In one transaction it re-reads the live roster, writes a frozen `TranscriptRosterEntry` for every live member (overrides, else defaults, with the role inside the membership), clears the freeze flag of anyone who has left, and writes the freeze record, with batched writes. Idempotent.

**Head-change hooks.** The freeze runs BEFORE the head change, from `cca.handoverHeads` (when it removes a current head), `admin.revokeCcaHead` and `admin.transferCcaHead` (`freezeBeforeHeadChange`). Grant-only paths never freeze. If the freeze fails the change is refused (`TRANSCRIPT_FREEZE_FAILED`); a skipped freeze never blocks it. The handover dialog warns heads to finish their records first and links to the transcript tab.

**Reading a roster.** For year X and CCA c: an active freeze for X shows the frozen entries; otherwise, if X is c's term year, the live members; otherwise "No member list was recorded for this year". A resident's transcript is assembled the same way, per CCA.

**Edit rights** (`editRefusal`, one guard `assertCanEditCcaYear`, used by roster edits and volunteer hours). Nobody edits a published year. Managers (admin, jcrc) edit any CCA while the year is collecting or closed. The head of the CCA edits only while the year is collecting and the CCA has no active freeze, or one made by the head's own lock. After a handover, head removal or close the head sees a read-only view: "Frozen on {date}. Ask the JCRC for changes."

**Year status.** `collecting -> closed -> published`.
- **Close year** (needs semester 2 start, a year that has begun): freezes every CCA with no active freeze (`close_year`), then closes.
- **Publish** (from closed only): freezes nothing; it refuses while any CCA has no active freeze.
- **Freeze remaining CCAs** (`periods.freezeRemaining`, admin or jcrc, closed only): freezes every CCA with no active freeze, one at a time, with the same code and reason (`close_year`) as Close year, and stays closed. It returns the frozen, already-frozen, left-alone and failed counts and can be run again after a failure. It writes no `ResidentEvent`; the actor and time are on each freeze. Refused with `CONFLICT:NOT_CLOSED` while collecting or published.
- **Reopen for review**: published to closed. **Back to collecting**: closed to collecting; frozen lists stay frozen.
- **Unfreeze** one CCA (manager, reason required, year not published): its entries become annotations again and the current member list is used until it is frozen again.

**Residents.** While a year is closed, `/transcript` shows a DRAFT: the same assembly, a note "Draft - check your information. If something is wrong, tell your CCA head or the JCRC." on page 1 and a DRAFT watermark on every page (printed too). Nothing is recorded as opened, there is no Ready badge and no download-by banner. Published behaviour is unchanged.

**Admin screen.** The Academic year section offers only the valid actions, and a "CCA member lists" table (state, date, who, member count, Unfreeze, "Not frozen only"). From 1 June until the year is closed a banner says how many CCAs are not frozen yet.

**Head's tab.** "Lock member list for {year}" (confirmation says edits stay open until the JCRC closes the year). The year selector defaults to the CCA's term year.

### Data retention

`purgeAcademicYear(db, academicYear, { dryRun })` (`services/transcript/retention.ts`) deletes every document of one year across `TRANSCRIPT_COLLECTIONS` (period, roster entries, volunteer records, awards, JCRC records, access records, freezes), in one transaction, and returns counts per collection; `dryRun` only counts. Every record is keyed by its year and never refers to another year's, so other years are untouched. A test parses `prisma/schema.prisma` and fails if a model with an `academicYear` field is missing from the registry, so a later collection cannot be forgotten. Whether and when to purge old years is a future decision; there is no script and no screen.

## 24. CCA Activities and Other involvement

A CCA can record the activities it ran during a year and who took part. They appear on each participant's transcript: under the CCA's row for a member, under "Other involvement" for anyone else.

**Data (new collections only).**
- `CcaActivity { academicYear, ccaID, title, description?, period (full | sem1 | sem2), createdBy/At, updatedBy/At, removedAt/By }`, index `activity_year_cca`.
- `CcaActivityParticipant { activityID, academicYear, ccaID, userID, role?, description?, addedBy/At, updatedBy/At, removedAt/By }`, unique per activity and person (`participant_activity_user`), index `participant_year_user`.
- `TranscriptPeriod` also records who closed a year and who put it back to collecting (`closedAt/By`, `backToCollectingAt/By`).
- Both new collections are in the retention registry, so purging a year removes that year's activities and participants (and only those).

**Limits.** Title 1 to 80 characters, description up to 300, period `full | sem1 | sem2`. No visible count limit on activities or participants (only hidden safety caps, section 31). A participant's role is up to 60 characters and their description up to 300. Text follows the same plain-text rules as the rest of the transcript (control and invisible characters are rejected).

**Soft removal.** Nothing is deleted. Removing an activity sets `removedAt/By`; removing a participant (by leaving them out of `participants.set`) does the same. A removed activity or participant never renders. Restoring an activity is refused if it would take the CCA over 20. A person who was removed and is listed again gets their old row back (one row per person per activity).

**API** (`transcriptManage`). `activities.list` (with `includeRemoved`), `activities.create`, `activities.update`, `activities.remove`, `activities.restore`, and `participants.set`. `participants.set` REPLACES the activity's active people with the list given, in one transaction: new people are added, missing ones are soft-removed, and a row is rewritten only if its role or description changed. Each person must be an existing resident (anyone in the hall, not only members of the CCA); a duplicate or unknown person refuses the whole call and changes nothing. Every procedure checks the caller heads this CCA (or is a manager); every write then runs the one edit guard (`assertCanEditCcaYear`) for the activity's own year: nobody once published, managers while collecting or closed, the head only while collecting and not frozen at handover (or frozen by their own lock). An activity can be read through its own CCA only; another CCA's id is "not found". The actor and time are recorded, shown as display names.

**Who can search for people to add.** `residents.search` now admits a manager or the head of ANY CCA (it was volunteering CCAs only), so a head can add someone from outside the CCA. A head who is not a manager still searches by display name only, with the same masked matric, 10 hits and 60 requests per 10 minutes. Anyone else gets `NOT_A_CCA_HEAD`.

**On the transcript.** Membership uses the same rule as the CCA rows: the frozen list when the CCA has an active freeze for the year, otherwise the live roster when the year is the CCA's term year. A member's activities for that CCA nest under its row as an "Activity | Role | Description" table, ordered full year, semester 1, semester 2, then by title. A part-year activity reads "Title (Sem 1)" / "Title (Sem 2)". The description is the person's own, else the activity's general one, else blank; a blank role stays blank. If the CCA also has an additional contribution it is the last row of that table ("Additional contribution"); a CCA with no activities keeps its single "Additional contribution:" line. Activities of a CCA the person is not a member of go under a section "Other involvement" (Activity | Organised by | Role | Description), after the CCA section and before Volunteer hours; it is left out when empty, and a transcript with only that section is not an empty year. The notes page lists each activity's general description as "Activity: description" under its CCA's note, and "Notes on other involvement" lists the others. Sem 1 / Sem 2 is explained there when any activity is part-year.

**Head screen** (`/cca/[ccaID]/transcript`). An "Activities" section above the roster: a plain count ("1 activity"), Add activity, each activity with Edit and Remove (confirmation), and Show removed with Restore. The editor is a dialog on a desktop and a full-screen sheet on a phone: title, period, description with counters, a tick list of the CCA's members (name filter, Select all, Clear all, which act on the members the filter shows), a search to add people from outside the CCA (chips), and "Customise each person" for a role and description per person ("Leave empty if no role"; "What they did; leave empty to use the general description"). Saving writes the activity, then replaces its participants; if the second step fails the editor stays open on the saved activity so a retry makes no copy. The section is read-only, with the reason, when the head may not edit the year.

**Roster editor and unsaved changes.** Below the `md` breakpoint the roster is a list of cards (a table from `md`), with a name filter. While anything is unsaved a sticky bar shows "N unsaved changes" with Save all (one row after another; a failed row keeps its edit and shows its own message) and Discard; each row keeps its own Save. A shared hook, `useUnsavedChangesGuard(isDirty)`, asks the browser to confirm reloading or closing the tab and returns a `confirmLeave()` used before the year selector changes. It guards the roster editor, the activity editor, the JCRC page editor and the Academic year panel.

## 25. Volunteer activities

Volunteer hours are recorded by ACTIVITY, with sessions and an attendance grid. This replaces the single-record model (`VolunteerRecord`, one create/void row per person), which is removed with its screens, procedures and tests; it never reached production. Sections 14 to 17 describe that old model.

**Data (new collections only).**
- `VolunteerActivity { academicYear, ccaID, title, kind (regular | oneoff), description?, defaultHours?, createdBy/At, updatedBy/At, removedAt/By }`, index `vact_year_cca`.
- `VolunteerSession { activityID, academicYear, ccaID, date, hours, createdBy/At, updatedBy/At, removedAt/By }`, index `vsession_activity`. The date is a Singapore calendar date stored as midnight Singapore time (`sgDateToInstant`).
- `VolunteerPerson { activityID, academicYear, ccaID, userID, addedBy/At, removedAt/By }`, unique per activity and person (`vperson_activity_user`), index `vperson_year_user`.
- `VolunteerAttendance { sessionID, activityID, academicYear, ccaID, userID, hoursOverride?, markedBy, markedAt }`, unique per session and person (`vattend_session_user`), index `vattend_year_user`. A TICK is the presence of the row; un-ticking deletes it (ticks are state, not records).
- Every child repeats `academicYear` and `ccaID`, so a year can be purged; all four are in the retention registry (and the registry test covers them).

**Hours.** A person's hours in an activity = the sum, over the activity's ACTIVE sessions where they have a tick, of the tick's override or the session's hours; only for ACTIVE people of ACTIVE activities (`personTotals`). Removing a session, a person or an activity never deletes ticks, so everything can be restored. Hours are quarter hours from 0.25 to 24.

**Rules.**
- Every write needs the CCA to be tagged `CcaProfile.isVolunteering` (managers too): `NOT_A_VOLUNTEERING_CCA`, shown as "This CCA is no longer a volunteering CCA." Reading never does, and an untagged CCA's activities keep rendering on transcripts.
- Every write runs the one edit guard (`assertCanEditCcaYear`) for the activity's own year: nobody once published; managers while collecting or closed; the head of THIS CCA only while collecting and not frozen at handover (or frozen by their own lock). Reads need the head of this CCA or a manager. Another CCA's id is "not found".
- Limits: title 1 to 80, description up to 300, default hours 0.25 to 24. No visible count limit on activities, sessions or people (hidden safety caps only, section 31).
- A one-off is created with exactly ONE session (date and hours required, the date inside the year) and can neither gain nor lose one; its date and hours change through the activity. A regular activity's sessions are added with `sessions.add`: with no date and hours it is a week after the LATEST active session with that session's hours; the first uses today (Singapore) clamped into the year and the activity's default hours (1 if none). Dates outside the year are refused.
- `people.set` replaces the active people (any existing resident; duplicates and unknown people refuse the call and change nothing).
- `attendance.save` applies a batch of ticks, un-ticks and override changes in ONE transaction. Each change must name an ACTIVE session and an ACTIVE person of the activity; one that does not (or a repeated cell) rejects the whole batch. A tick that omits `hoursOverride` keeps the existing one; null clears it.
- Actor and time are recorded on every change and shown as display names.

**API** (`transcriptManage.volunteer`): `activities.list` (counts, total hours; `includeRemoved`), `activities.get` (one activity with sessions, people, ticks and totals, for the grid), `activities.create / update / remove / restore`; `sessions.add / update / remove / restore`; `people.set`; `attendance.save`.

**Transcript.** The Volunteer hours section has one row per activity the resident has hours in: Activity | Type ("Regular" or "One-off") | Organised by (the CCA) | Hours, then a "Total" row. Hours are printed without trailing zeros (1.5, 42); session counts and dates are never printed. Regular activities first, then one-off ones, each by title. The section is left out when empty.

**Head screen** (`/cca/[ccaID]/transcript`, volunteering CCAs only). A "Volunteer hours" card: a plain count ("1 volunteer activity"), Add volunteer activity, each activity with type, people, total hours, Attendance, Edit, Remove (confirmation), and Show removed with Restore. The editor (dialog on desktop, full-screen sheet on a phone): title, type (fixed once saved), description, default hours (regular) or date and hours (one-off), the CCA's members as a tick list (filter, Select all, Clear all) and "Add someone outside the CCA" (search, chips). Saving writes the activity, then its people.
- **Attendance, desktop:** people as rows (sticky name column), sessions as columns, at most the 8 most recent drawn with Earlier sessions / Later sessions. A column header shows the date and hours with Tick all, Clear all, Copy previous (the session before it; who was ticked, not overrides) and Edit session (date, hours, Remove session); a row has Tick all sessions and Clear all. A click toggles a cell; "h" on a ticked cell sets or clears its hours override, which then shows in the cell. A Total column follows the grid live. Add session adds the next default session.
- **Attendance, phone (below md):** one session at a time with a date selector and previous/next arrows, a tick list of people with Tick all, Clear all and Copy previous session, an hours input for each ticked person and each person's live total.
- Both views share one local state and one sticky bar: "N unsaved changes", Save (one `attendance.save`), Discard. The unsaved-changes guard applies (reload, closing, opening another activity). A one-off shows the same grid without paging.

## 26. Awards

Awards come from a CATALOGUE and are assigned to residents for a year. This replaces the earlier one-at-a-time "add an award" form (section 17's `awards.create` and `awards.void`).

**Data.**
- `AwardType { name, normalizedName (unique, `award_type_name`), defaultCitation?, archivedAt/By, createdBy/At, updatedBy/At }`. The catalogue has NO year, so it is not in the retention registry and a purge never touches it. The normalised name is lower-case, trimmed, with inner spaces collapsed, so "Full  Colours" and "full colours" are one award. Archived entries still hold their name.
- `Award` gains `awardTypeID?`, `importBatchID?`, `updatedBy?`, `updatedAt?` and the index `award_year_type`. `title` stays the name COPIED at assignment: renaming a catalogue entry never changes a past award. `voidedAt/By` is "removed" on the screens; nothing is deleted.
- `AwardImportBatch { academicYear, fileName?, rowCount, importedCount, skippedCount, createdBy/At, undoneAt/By }` (year-keyed, in the retention registry), index `award_batch_year`.

**Rules.** Everything here is manager-only (admin or jcrc, a live role read). Awards of a year refuse writes once that year is published (`PERIOD_PUBLISHED`); the catalogue is not year-bound. Every write records who and when, shown as display names.
- Catalogue (`awardTypes`): `list` (`includeArchived`, with how many active awards each has given), `create`, `update`, `archive`, `restore`. Name 1 to 80, default citation up to 300 (the same plain-text rules as elsewhere). A name clash (archived entries included) is `AWARD_NAME_TAKEN`. No hard delete. An archived entry is hidden from assignment; awards already given keep rendering.
- `awards.assign({ academicYear, awardTypeID, recipients: [{ userID, citation? }] })`, any number of people (a hidden cap of 2,000 per request), in one transaction. One `Award` per person with `title` = the entry's name and `citation` = the one given, else the entry's default. A DUPLICATE (an active award for the same year and person of the same entry, or with no entry and the same normalised name) is skipped and returned by name. An unknown resident or an archived entry refuses the whole request.
- `awards.list({ academicYear, search?, includeRemoved? })` (search matches the award or the person), `update({ id, title 1..80, citation ..300 })`, `remove`, `restore` (refused with `AWARD_DUPLICATE` if the person now holds the award from another row), `bulkRemove` / `bulkRestore({ ids })` (at most 500; a bulk restore skips and names the duplicates).
- `awardBatches.list({ academicYear })` (with how many of each upload's awards are still active) and `awardBatches.undo({ batchId })`: soft-removes every STILL-ACTIVE award of the upload and marks it undone; the claim is compare-and-set, so an upload cannot be undone twice; awards removed by hand stay as they are.

**Transcript.** The Awards section is a table "Award | Year" (the year as 2026/27) with the citation, if any, on a line beneath in smaller italic text. By title. Removed awards never render.

**Screens.** `/admin/transcripts/awards` (the Awards section of `/admin/transcripts` is now a short count with a link), with tabs:
- **Awards**: year selector; "Assign an award" (pick a catalogue award or "New award" with a name and default citation, add residents as chips, a citation per person that defaults to the award's, Assign, then "12 assigned. Skipped (already have it): A, B."); search; "Group by award" (default on: "Full Colours: 14 residents", expandable, with a select-all per group); inline edit of title and citation; per-row Remove and Restore; checkboxes with Remove selected / Restore selected behind a confirmation; Show removed.
- **Catalogue**: add, edit, archive and restore, Show archived.
- **History**: uploads for the year (file, who, when, imported, skipped, status) with Undo behind a confirmation ("This removes the N awards from this upload. You can restore them one by one later.").
A published year makes the year-bound tabs read-only with the existing note. The year and tab change only after unsaved typing is confirmed away, and a reload asks too.

**CSV import.** The Import tab (between Catalogue and History) loads awards from a CSV in five steps, for the year chosen at the top. The client parses the file with the admin bulk wizard's `parseCsv` and sends rows `{ identifier, award, citation }`; the procedures are `awardImport.preview` and `awardImport.commit` (manager-only; both refuse a published year).
- **File.** "Download template" gives `identifier,award,citation` and one made-up example row. Upload a .csv or paste the text. More than 10,000 rows is refused with "This file has more than 10,000 rows. Split it and upload in parts."
- **Columns.** Headings named identifier, email or nusnet, award, and citation are mapped by themselves and can be changed; exactly one identifier and one award column are needed. The wizard's own `CsvColumnMapper` (fixed to its role-import column kinds) did not fit, so a transcript-local mapper is used.
- **Identifiers** resolve with the bulk wizard's own `bulkResolver` (`resolveIdentifier` for an email or an E-format NUSNET id; any other NUSNET id only when a real account exists). Both functions were made `export` in `admin.ts` (nothing else in that file changed) and are imported, not copied. The resolver is built once per request, then used for each row, then a resident lookup confirms the account exists.
- **Row status**, with a reason for every row that is not Ready: Invalid (empty or over-long award or citation, control or invisible characters; checked first), Not found (no such resident), Duplicate (the person already holds the award for the year, by catalogue entry or by normalised name; or the same person and award appear earlier in the file), otherwise Ready.
- **Award names** match NON-archived catalogue entries by normalised name. A name that matches no live entry is "new" and needs a decision, among the rows that would be imported: Create new award (added to the catalogue with no default citation) or Use existing award. A name an archived entry already holds is treated as new; the archived entry is offered as "(archived)" and using it does not unarchive it; Create is not offered for it. A citation is the row's own, else the matched award's default.
- **Commit** re-does everything on the server and never trusts the preview: resolution, statuses and matching. It refuses while a new name is undecided, creates the chosen catalogue entries first, then writes the Ready rows (less any the user skipped) in chunks of 200 under ONE `AwardImportBatch` (rowCount, importedCount, skippedCount, fileName). A row that became a duplicate since the preview is skipped, not failed. The result lists every skipped row with its reason. A local test imports 2,000 rows in about 1.5 seconds.
- **Screens.** The preview shows counts per status, a status chip in words as well as colour, a reason column, a Skip toggle on Ready rows, and a "Decide unknown awards" panel; "Import N rows" is enabled only when every new name has a decision. Below 704px of its own width the preview is one card per row. While a file is open and not imported, the unsaved-changes guard applies. The summary reads "48 imported, 2 skipped" and links to History, where Undo removes the batch. A published year makes the tab read-only. The write itself is one request, so the progress bar is an animation, not a count.

**Roster layout.** The roster on a CCA's transcript tab chooses cards or the table from its own container's width (a ResizeObserver; cards below 896px, the table's width), not from the window, because the side menu leaves a narrow column even on a wide window. In the table the Save column is sticky at the right edge, so it is never hidden by sideways scrolling.


## 27. Per-resident corrections

A PUBLISHED year is read-only for everyone. Admin and JCRC can correct ONE resident at a time, after unlocking that resident. Nothing is shown on the document: the transcript renders from the data, so a correction shows at once, with no "amended" mark.

**Data (all new, all year-keyed, all in the retention registry, so a year's purge removes them with the rest).**
- `ResidentUnlock { academicYear, userID, reason, unlockedBy/At, relockedBy/At }`, index `unlock_year_user`. ACTIVE while `relockedAt` is empty; at most one active per resident and year (kept by the service: a second unlock is `ALREADY_UNLOCKED`).
- `ResidentWithhold { academicYear, userID, reason, withheldBy/At, releasedBy/At, releaseNote }`, index `withhold_year_user`. ACTIVE while `releasedAt` is empty; at most one (`ALREADY_WITHHELD`).
- `ManualMembership { academicYear, userID, ccaID, duration?, roleLabel?, roleDuration?, extraContribution?, createdBy/At, updatedBy/At, removedAt/By }`, unique `manual_year_user_cca`.
- `ResidentEvent { academicYear, userID, action, reason?, summary?, actor, at }`, index `revent_year_user`. `action` is `unlock | relock | withhold | release | manual_add | manual_edit | manual_remove | manual_restore | correction`.
- `JcrcService` gained `removedAt/By` (the only change to an existing transcript model; nothing outside our own collections changed).

**The guard.** `assertCanEditForResidents(db, actor, { ccaID?, academicYear, affectedUserIDs })` (services/transcript/residentRecords.ts, decided by the pure `decideWrite` in lib/transcript/corrections.ts):
1. If the ordinary edit guard (`assertCanEditCcaYear`, or for awards and JCRC pages "a manager, and the year is not published") allows it, the write is allowed and is NOT a correction.
2. Otherwise, only when the year is PUBLISHED, the actor is a manager (admin or jcrc, a live role read), the write names at least one resident, and EVERY affected resident has an ACTIVE unlock, the write is allowed as a CORRECTION: the caller logs one `correction` event per affected resident with a short summary, for example "Roster: Soccer (MALE) role set to Captain".
3. A manager touching a published year with some affected resident still locked is refused as `FORBIDDEN:ONLY_UNLOCKED_RESIDENTS` ("This year is published. Unlock the resident first, and change only their records."), and nothing is written, not even for the unlocked residents of the same batch.
4. Everyone else (a head, anyone else, or a write that names no resident) gets the ordinary refusal, `PRECONDITION_FAILED:PERIOD_PUBLISHED` or the head-specific one. Heads never get correction powers, with or without an unlock.
The affected residents are always worked out on the server, from the stored rows and the change itself (the diff), never from what the client claims.

| Write | Affected residents |
| --- | --- |
| `roster.upsert` | the member named (resolved to their canonical key) |
| `participants.set` | everyone added, restored, changed or removed by the diff against the stored participants |
| volunteer `people.set` | everyone added, restored or dropped |
| volunteer `attendance.save` | everyone named in the change set |
| `awards.assign` | the recipients |
| `awards.update / remove / restore` | the holder of that award |
| `awards.bulkRemove / bulkRestore` | the holders of the selected awards, guarded year by year |
| `awardBatches.undo` | everyone still holding an active award of the upload |
| `awardImport.commit` | the resident on every Ready row that is not skipped (checked before the catalogue is touched) |
| `jcrc.saveFor / saveMine / remove / restore` | the member |
| manual CCA entry writes | the resident |

Still locked on a published year, even with an unlock: every activity-level field (an activity's title, general description, period and sessions), and creating, removing or restoring an activity. Use Reopen for review to change those.

**Unlock and relock** (`corrections.unlock / relock`). Unlock needs a reason (3 to 500 characters) and a year that is closed or published (`YEAR_NOT_IN_REVIEW` while collecting). Relock takes an optional note. Both add an event; relocking closes the unlock (it is never deleted).

**Manual CCA entries** (`corrections.memberships.saveManual / removeManual / restoreManual`). For a resident missing from the membership data. A manual entry counts as MEMBERSHIP of that CCA wherever the roster rule is used: the CCA row, which activities nest under it (the rest stay under "Other involvement"), and the notes. If the roster also has the CCA for that resident, the roster entry WINS and the manual one is ignored (the admin screen says so). A manual row renders like any other; "Manual" is shown on the admin screens only. The role period must fit inside the membership period (`ROLE_PERIOD_OUTSIDE_MEMBERSHIP`). A removed entry cannot be saved over (`MANUAL_REMOVED`): restore it first. Manual writes always add their own event (`manual_add`, `manual_edit`, `manual_remove`, `manual_restore`); in a published year they also need the unlock.

**History** (`corrections.history`). Every event for the resident and year, newest first, with the person's display name and the time in Singapore.

**Screen** `/admin/transcripts/residents` (linked from `/admin/transcripts`, admin and jcrc only, gated by the segment layout and re-checked by every procedure):
- A year selector and the resident picker. The resident panel shows the status line (Collecting, Draft or Published, "withheld from the resident" when on hold), an "Unlocked" badge, and the buttons Preview transcript, Unlock (a dialog with a required reason) or Relock (optional note), Withhold (required reason) or Release (optional note).
- Six sections as tabs: CCA memberships (roster entries edited with the same `roster.upsert` the heads use, and manual entries with "Add manual CCA entry": CCA, duration, role, role period, contribution), Activities (their role and description on each activity of any CCA, Remove and Restore, and "Add to an existing activity"), Volunteer hours (a tick and an optional hours override per session, saved with `attendance.save` for this one resident, with a live total), Awards (inline edit, remove, restore, Show removed, assign from the catalogue), JCRC page (the whole page, Remove page and Restore page), and History.
- Every section is read-only with "Published. Unlock this resident to make corrections." until the resident is unlocked; the server enforces it either way. The year, the resident and the tab change only after unsaved typing is confirmed away, and a reload asks too. Records are cards whose fields wrap by the card's own width, so there is no sideways scroll at 375px.

## 28. Withholding a transcript

`corrections.withhold` puts ONE resident's transcript on hold for a year; `corrections.release` lifts it. Needs a reason (withhold) and takes an optional note (release). Both add an event.
- While a hold is on, `/transcript` shows only "Your transcript is on hold. Contact the hall office." for that year, draft or published (`transcript.mine.get` returns `status: "on_hold"` and loads nothing else). The year is still listed. No `TranscriptAccess` row is written and the "Ready" badge and the dot on the profile button are not shown for it (`readiness` skips a held year). A hold in a collecting year changes nothing the resident can see.
- A manager's preview still renders the document, with the on-screen note "Withheld from the resident" (hidden in print).
- Releasing restores the transcript and, if the resident never opened it, the Ready badge.
- A hold does not affect anyone else's transcript, and it is independent of unlocking.

## 29. CRUD matrix

Every editable item can be created, viewed, edited, removed (softly) and restored, with who and when recorded on every change. "Locked" is when writes are refused. A published year is locked for everyone except a manager correcting an UNLOCKED resident's own records (section 27). Nothing in the transcript collections is hard-deleted from a screen: removal sets `removedAt/By` (or `voidedAt/By`, `archivedAt/By`), and the only delete is the per-year purge function (no UI).

| Entity | Create | View | Edit | Remove | Restore | Who | Locked when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Academic year (period) | first save of the semester 2 date | Academic year panel | semester 2 date; download-by date (any time) | none (purge only) | none | admin, jcrc | semester 2 date: published |
| Year status | Close, Publish | status and history on the panel | Reopen, Back to collecting | n/a | n/a | admin, jcrc | by the status machine |
| CCA member list freeze | at handover, head change, Lock roster, Close year | Member lists table | n/a | Unfreeze (reason) | Freeze again | system; head (Lock roster); admin, jcrc (Unfreeze) | Unfreeze: published |
| Roster entry (duration, role, role period, contribution) | Save a row | head tab; resident panel | Save; Clear role, Clear contribution | Clear, or Reset to default (live list) | type it again | head of that CCA; admin, jcrc | head: after handover or close; everyone: published (admin, jcrc with an unlock) |
| Manual CCA entry | Add manual CCA entry | resident panel | Save | Remove | Restore | admin, jcrc | published without an unlock |
| CCA activity | Add activity | head tab | Edit | Remove | Restore | head of that CCA; admin, jcrc | head: after handover or close; everyone: published (no unlock) |
| Activity participant | Add (list or "Add to an existing activity") | head tab; resident panel | role, description | Remove | Restore, or list again | head of that CCA; admin, jcrc | published without an unlock |
| Volunteer activity | Add | head tab | Edit | Remove | Restore | head of that CCA; admin, jcrc | as an activity |
| Volunteer session | Add session | head tab | Edit | Remove | Restore | as above | as an activity |
| Volunteer person | people list | head tab | n/a | drop from the list | list again | as above | published without an unlock |
| Volunteer tick and hours override | tick | grid; resident panel | override | untick (the tick is a state, so the row is deleted) | tick again | as above | published without an unlock |
| Award type (catalogue) | Add | Catalogue tab | Edit | Archive | Restore | admin, jcrc | never (no year) |
| Award | Assign; CSV import | Awards tab; resident panel | inline edit | Remove; bulk | Restore; bulk | admin, jcrc | published without an unlock |
| Award upload (batch) | Import | History tab | none | Undo | none (assign again) | admin, jcrc | published without an unlock for each holder |
| JCRC page | Save (the member, or a manager) | JCRC page; resident panel | Save | Remove page | Restore page | the member (own); admin, jcrc | published without an unlock |
| Resident unlock | Unlock | resident panel; History | none | Relock | Unlock again | admin, jcrc | year must be closed or published |
| Resident withhold | Withhold | resident panel; History | none | Release | Withhold again | admin, jcrc | never |
| Resident history | written by each change | History tab | none | none | none | system | never |
| First-opened record | when a resident opens a published year | drives the Ready badge | none | none | none | system | never |
| Volunteering tag | switch on | Volunteering CCAs | n/a | switch off | switch on | admin, jcrc | never |

**Gaps this pass closed.** Roster rows now have Clear role, Clear contribution and Reset to default (a live list only: a frozen list has no defaults to go back to; Save applies it). A JCRC page can be removed and restored (soft) by a manager. A manual CCA entry has the whole cycle. A resident's activity participation, volunteer ticks and awards can be edited from one place.

**Gaps left, on purpose.** A volunteer person can only be added or dropped from the CCA's own volunteering screen (the resident panel edits ticks, not who is on the activity). An award upload cannot be redone, only its awards assigned again. An unlock or a hold cannot be edited, only ended and made again. A transcript period and a catalogue entry have no remove (the purge function and archiving cover them). A tick is a state, so unticking deletes the row.


## 30. Requirements traceability

Every requirement in the project brief, where it is implemented, and the tests that prove it. Paths are under `src/` unless they start with `docs/`, `scripts/` or `prisma/`. "int" tests run against the local database (`npm run test:db`); the others are unit and view tests (`npm run test`).

### Feature requirements

| Requirement | Where | Tests | Status |
| --- | --- | --- | --- |
| One transcript per resident per AY; leadership roles stated, plain members blank | `services/transcript/loader.ts` `loadTranscriptInput`; `lib/transcript/assemble.ts` | `lib/transcript/__tests__/assemble.test.ts`; `services/transcript/__tests__/transcript.int.test.ts` | done |
| Only the resident's CCAs described; description from CcaProfile; missing ones handled | `loader.ts` `loadMemberships`; `assemble.ts` notes; `TranscriptSections.tsx` | `assemble.test.ts` ("Description not yet available"); `TranscriptDocument.test.tsx` | done |
| CCA activities: heads and managers create per CCA per AY (title 80, description 300, period, no count limit) | `services/transcript/activities.ts`; `lib/transcript/activities.ts`; `lib/transcript/manageInput.ts`; `app/cca/[ccaID]/transcript/_components/ActivityEditor.tsx`, `ActivitiesSection.tsx` | `activities.test.ts`, `manageInput.test.ts`, `activitiesUi.test.tsx`, `activities.int.test.ts` | done |
| People from a CCA-member tick list plus search for anyone in the hall; per-person role 60 / description 300 with fallback | `ActivityEditor.tsx` (Select all, Clear all, search); `activities.ts` `participantsSet`; `assemble.ts` fallback | `activityEditor.test.ts`, `activitiesUi.test.tsx`, `activities.int.test.ts` | done |
| Nested Activity / Role / Description table under the CCA row, "Additional contribution" last row (500) | `TranscriptSections.tsx`; `assemble.ts` | `TranscriptDocument.test.tsx`, `assemble.test.ts` | done |
| Non-members get "Other involvement" (Activity, Organised by, Role, Description); activity descriptions on the notes page | `assemble.ts`; `TranscriptSections.tsx` | `TranscriptDocument.test.tsx`, `assemble.test.ts`, `activities.int.test.ts` | done |
| Role period inside the membership period | `lib/transcript/duration.ts` `roleFits`; `manageRoster.ts` `assertRoleFitsMembership`; `lib/transcript/manualMembership.ts`; `headView.ts` `fitRolePeriod` | `rolePeriod.test.ts`, `rolePeriodRow.test.tsx`, `manualMembership.test.ts`, `transcriptManage.int.test.ts`, `corrections.int.test.ts` | done |
| Volunteering CCAs by `CcaProfile.isVolunteering`; admin page lists tagged only, search to add, Remove | `services/transcript/manageRecords.ts` `setVolunteering`; `app/admin/transcripts/_components/VolunteeringTags.tsx` | `panels.test.tsx`, `transcriptManage.int.test.ts` | done |
| Volunteer activities (regular / one-off, description), people tick list with Select all plus search, sessions (one-off has exactly one) | `services/transcript/manageVolunteer.ts`; `VolunteerEditor.tsx`; `lib/transcript/volunteer.ts`, `volunteerEditor.ts` | `volunteer.test.ts`, `volunteerEditor.test.ts`, `volunteerUi.test.tsx`, `volunteer.int.test.ts` | done |
| Attendance grid: per-session Tick all / Clear all / Copy previous, per-person Tick all / Clear all, per-cell hours override, live totals, one session at a time on a phone | `VolunteerAttendance.tsx`; `lib/transcript/volunteerGrid.ts` | `volunteerGrid.test.ts`, `volunteerUi.test.tsx` | done |
| Transcript shows total hours per activity, never session counts | `loader.ts` `loadVolunteering`; `TranscriptSections.tsx` | `assemble.test.ts`, `TranscriptDocument.test.tsx`, `volunteer.int.test.ts` | done |
| Award catalogue (name, default citation, archive, no hard delete) | `services/transcript/manageAwards.ts`; `awards/_components/AwardCatalogue.tsx` | `awards.test.ts`, `awardsUi.test.tsx`, `awards.int.test.ts` | done |
| One-shot assignment with search chips, per-person citation, duplicates skipped and listed | `manageAwards.ts` `awardsAssign`; `AssignAward.tsx`; `lib/transcript/awards.ts` `planAssignment` | `awards.test.ts`, `awardsUi.test.tsx`, `awards.int.test.ts` | done |
| CSV import reusing the bulk-import pattern (template, upload/paste, column map, preview with Ready / Not found / Duplicate / Invalid, catalogue matching, import, history with batch undo); identifier NUS email or NUSNET | `services/transcript/awardImport.ts` (reuses `parseCsv`, `resolveIdentifier`, `bulkResolver`); `AwardImport.tsx`; `AwardHistory.tsx` | `awardImport.test.ts`, `awardImportUi.test.tsx`, `awardImport.int.test.ts` | done |
| Awards list: group by award, search, filter by AY, inline edit, bulk remove / restore; transcript shows Award / Year with citation beneath | `AwardsList.tsx`; `manageAwards.ts`; `TranscriptSections.tsx` | `awardsUi.test.tsx`, `awards.int.test.ts`, `TranscriptDocument.test.tsx` | done |
| JCRC page: role, responsibilities, contributions rows with no header row (no row limit, 80/60/300, add/edit/remove/reorder), member's testimonial, Master and President signature placeholders | `manageRecords.ts` `jcrcSave`; `_components/JcrcSelf.tsx`; `JcrcPageBody.tsx`; `headView.ts` contribution helpers | `jcrcSelf.test.tsx`, `headView.test.ts`, `TranscriptDocument.test.tsx`, `transcriptManage.int.test.ts` | done |
| CRUD everywhere with soft remove, Show removed and Restore, actor and time on every change | each service; matrix in section 29 | `activities.int.test.ts`, `volunteer.int.test.ts`, `awards.int.test.ts`, `corrections.int.test.ts` | done (exceptions listed in section 29: a tick is a state; catalogue archives; periods have no remove) |
| Per-resident corrections: unlock one resident in review or published, correct, relock | `services/transcript/residentRecords.ts` (guard), `residentManage.ts`; `lib/transcript/corrections.ts`; `app/admin/transcripts/residents/**` | `corrections.test.ts`, `residentsUi.test.tsx`, `corrections.int.test.ts` | done |
| Manual CCA entries (tagged "Manual" in admin views only) | `residentManual.ts`; `lib/transcript/manualMembership.ts`; `loader.ts` merge | `manualMembership.test.ts`, `residentsUi.test.tsx`, `corrections.int.test.ts` | done |
| Withhold ("Your transcript is on hold. Contact the hall office.") and Release | `residentManage.ts`; `routers/transcript.ts` `mine.get`; `access.ts` `readiness`; `app/transcript/_components/OnHold.tsx` | `corrections.test.ts`, `corrections.int.test.ts` | done |
| Per-resident history with required reasons; no "amended" mark | `residentRecords.ts` `recordResidentEvent`, `logCorrections`; `HistoryTab.tsx`; `residentInput.ts` `reasonInput` | `corrections.int.test.ts`, `residentsUi.test.tsx`, `residentView.test.ts` | done |
| "My transcript" under My Applications (desktop and mobile), Ready badge and dot, first-opened record; link under My CCAs removed | `app/_components/header.tsx`; `services/transcript/access.ts`; `app/profile/page.tsx` | `headerEntry.test.tsx`, `transcript.int.test.ts` | done |
| Per-AY download-by date shown as a banner | `periods.ts` `upsertDownloadBy`; `lib/transcript/pageState.ts` `downloadByBanner`; `app/transcript/page.tsx` | `downloadBanner.test.ts`, `periods.test.ts`, `transcript.int.test.ts` | done |

### Academic years and freezing

| Requirement | Where | Tests | Status |
| --- | --- | --- | --- |
| AY 1 Aug to 31 Jul, rolls over by date | `lib/transcript/academicYear.ts` | `academicYear.test.ts` | done |
| Every record keyed by year, never referencing another year; tested, documented per-AY purge, no UI | `services/transcript/retention.ts`; section 23 | `retention.test.ts` (registry parses the schema), `lifecycle.int.test.ts`, `corrections.int.test.ts` | done |
| Each CCA's roster frozen at its handover for its oldest unfrozen AY, never a future AY | `services/transcript/freeze.ts`; `lib/transcript/lifecycle.ts` `termAcademicYear`, `freezeTarget` | `lifecycle.test.ts`, `lifecycle.int.test.ts` | done |
| Before handover a removed member is gone; after handover new members count toward the next AY | `loader.ts` (live vs frozen); `liveRoster.ts` | `lifecycle.int.test.ts`, `transcript.int.test.ts` | done |
| Heads may Lock roster; Close year freezes every CCA not yet frozen | `freeze.ts`; `routers/transcriptManage.ts` `roster.lock`; `periods.ts` `closeYear` | `lifecycle.int.test.ts` | done |
| After a freeze, the frozen year is editable by JCRC/admin only; the handover dialog warns heads | `editRights.ts`; `lib/transcript/lifecycle.ts` `editRefusal`; `app/cca/_components/CcaHandoverDialog.tsx` | `lifecycle.test.ts`, `lifecycle.int.test.ts` | done |
| Any head change that removes a current head freezes first (handoverHeads, revokeCcaHead, transferCcaHead); grant-only never; a failed freeze refuses the head change | `freeze.ts` `freezeBeforeHeadChange`; hooks in `routers/cca.ts`, `routers/admin.ts` | `lifecycle.int.test.ts` | done |
| Admin/JCRC can Unfreeze while the AY is not published | `freeze.ts` `unfreezeCca`; `FreezeTable.tsx` | `freezeTable.test.tsx`, `lifecycle.int.test.ts` | done |
| Status collecting, closed (draft "Draft - check your information"), published; Reopen for review; Back to collecting (freezes stay); JCRC and admin control it | `periods.ts`; `lib/transcript/lifecycle.ts` `transitionBlocker`; `PeriodPanel.tsx`; `TranscriptDocument.tsx` | `lifecycle.test.ts`, `panels.test.tsx`, `TranscriptDocument.test.tsx`, `lifecycle.int.test.ts` | done |
| Published locks edits except per-resident corrections | `editRights.ts`; `residentRecords.ts` | `corrections.test.ts`, `corrections.int.test.ts`, `transcriptManage.int.test.ts` | done |
| Heads edit only the CCA's current term AY, or a year they locked, never after a handover or close-year freeze | `lib/transcript/lifecycle.ts` `editRefusal`; `editRights.ts` | `lifecycle.test.ts`, `lifecycle.int.test.ts` | done |
| Residents keep access to past published transcripts | `periods.ts` `listViewableYears`; `routers/transcript.ts` `mine` | `transcript.int.test.ts` | done |

### Decisions

| Decision | Where | Tests | Status |
| --- | --- | --- | --- |
| No commitment level, no per-entry signatures; no verification (no code, QR, /verify, snapshots, reissue states) | `lib/transcript/types.ts`; the /verify pages are removed | `TranscriptDocument.test.tsx` (no verification text); print checks | done |
| Awards editor is jcrc and admin | `lib/transcript/permissions.ts`; `manageAccess.ts` `requireManager` | `permissions.test.ts`, `transcriptManage.int.test.ts` | done |
| No backfill: transcripts start at AY2026/27 | `lib/transcript/lifecycle.ts` `FIRST_ACADEMIC_YEAR` | `lifecycle.test.ts` | done |
| Template C layout (crest every page, black and white, page 1 sections, JCRC page, notes page, one-line year cell, "Head (Sem 2)", notes key, no faculty) | `app/transcript/_components/*`; `assemble.ts` | `TranscriptDocument.test.tsx`, `assemble.test.ts`; print checks | done |
| Durations full / sem1 / sem2 per member per CCA per AY, default from `decidedAt` vs `sem2Start` (Singapore midnight), shown only when not full | `lib/transcript/duration.ts`; `lib/transcript/sgDate.ts`; `manageRoster.ts` | `duration.test.ts`, `sgDate.test.ts`, `transcriptManage.int.test.ts` | done |
| Vitest the only new dev dependency; `npm run test` DB-free, `npm run test:db` local DB | `package.json`, `vitest.config.ts` | both suites | done |


## 31. Final fixes

**Publish needs every CCA frozen.** `periods.publish` refuses with `PRECONDITION_FAILED:CCAS_NOT_FROZEN` while ANY CCA has no active freeze for the year (a freeze undone during review, or a CCA created after Close year). The text is "Some CCAs are not frozen for AY2026/27: Soccer (MALE), Chess Club. Use Freeze remaining CCAs, then publish." The Academic year panel shows the same line inline while the year is closed (`periods.unfrozenNames`), with a "Freeze remaining CCAs (N)" button next to Publish. The button is hidden unless the year is closed and at least one CCA is unfrozen. Its confirmation reads "This freezes the member lists of N CCAs for AY2026/27: <first 5 names>, and more. Their current members will be used." (", and more" only past five), the button is disabled while it runs, and an inline line reports the result. The year stays closed.

**Close year goes one CCA at a time.** Each CCA freezes in its own transaction, in turn (no parallel workers). A CCA whose freeze fails is counted and the rest go on; the year then stays collecting and the result says "not closed yet", with the frozen, already-frozen, left-alone and failed counts and the failed names. Running Close year again finishes the rest.

**More indexes** (our collections only, added with `db push`): `vattend_activity` on `VolunteerAttendance(activityID)` for every read of one activity's ticks; `award_batch` on `Award(importBatchID)` for an upload's awards (History counts, Undo); `award_type` on `Award(awardTypeID)` for how many awards each catalogue entry has given across years; `freeze_cca` on `CcaYearFreeze(ccaID)` for a CCA's freezes across years (its term year, the loader).

**One active unlock or hold per resident and year.** `ResidentUnlock.activeKey` and `ResidentWithhold.activeKey` are unique (`unlock_active_key`, `withhold_active_key`): "<year>|<userID>" while active, rewritten to "<year>|<userID>|ended|<id>" in the same write that relocks or releases. Unlocking or withholding again, or five times at once, leaves one record and one history line, and the call succeeds (it is idempotent). The record and its history line are written in one transaction; the confirm button is disabled while the request is in flight.

**Partial uploads.** `AwardImportBatch.status` is `complete` or `partial`. An upload that fails after some chunks were written is marked `partial` with the counts actually written and refuses with "The upload stopped part way: N imported. Undo it from History, fix the file, and upload again." History shows "Partly imported"; Undo removes exactly that batch's awards. Each chunk is written with its history lines in one transaction.

**A correction and its history line are one write.** Every correction (roster, participants, volunteer people and ticks, awards, bulk and import, JCRC page, manual entries, participation) writes its data and its `ResidentEvent` in the same transaction, so neither exists without the other.

**No header rows.** The activity rows nested under a CCA row on the transcript, and the JCRC "Contributions during the year" rows, have no "Activity | Role | Description" header row (three aligned columns, the indent, and "Additional contribution" as the last row stay). Other involvement keeps its header row.

**Year switcher.** On `/transcript` the switcher shows whenever the resident has a published year or the current academic year is closed. It lists every published year, sorted, plus the current year when it is not published: "AY2026/27 (not yet available)" while collecting (the calm not-available page, with the switcher) or "AY2026/27 (draft)" while closed (the draft view). A requested `?ay=` that is not a choice falls back to the latest published year; a requested current year is shown as it is. With nothing published and the current year collecting, only the calm page shows, with no switcher. The switcher also appears on the on-hold page, so another year can still be opened.

**No visible count limits.** No "N of 20" counters or "limit reached" messages: screens show plain counts ("1 activity", "3 volunteer activities", "2 contributions"). The only count limits are hidden safety caps per request, far above real use: 1,000 activities and 1,000 volunteer activities per CCA and year, 1,000 sessions per activity, 2,000 people or participants per save, 200 JCRC rows, 2,000 award recipients per assign, 2,000 ids per bulk action, 20,000 ticks per save, and 10,000 CSV rows per upload ("This file has more than 10,000 rows. Split it and upload in parts."). Past a cap the server answers "That is more than one save can take. Do it in smaller steps." Text length limits are unchanged.

## 32. Header and layout fixes

**Header details.** Page 1 shows ONE row of four labelled fields across the full width: NAME (about twice as wide as each of the others), MATRIC NO., ACADEMIC YEAR (value "AY2026/27"; renamed from "Residency") and DATE ISSUED. There is no Faculty, Block or year of residence and no empty column; a name too long for its column wraps inside it. `YearIssueInput` is now `{academicYear, issuedOn}`, and the loader no longer reads the profile's block. The JCRC page header uses the same row without empty columns (Name, Matric no., Position, Term; Position gets the extra width).

**Semester suffixes.** Wherever the transcript prints "Sem 1" or "Sem 2" (activity titles under a CCA and in Other involvement, the Year cell, part-year roles such as "Head (Sem 2)", the notes), "Sem" and the number are joined by a no-break space (U+00A0), and a parenthesised "(Sem 2)" sits in a no-wrap span so it never splits across lines. The rest of a long title wraps normally.

**Footer baseline.** The name and the page count now share one baseline in Chrome's print output (see the Footer note under Print).

**CCA table (numbered, inline descriptions).** Replaces the nested activity rows and the Explanatory notes page. Section I is ONE table: # | CCA / activity | Role | Description | Year, with one header row (repeated on each printed page). CCAs are numbered 1, 2, 3 (the JCRC row too); each activity follows its CCA as 1.1, 1.2 ... on ONE row, title indented, with the person's role, their description (else the activity's, else blank) and an empty Year. "Additional contribution" is the last, unnumbered row under its CCA, its text in the Description column. The CCA description is `CcaProfile.description` with whitespace collapsed and cut at the last word boundary at or before 180 characters, ended with "…" (`ccaDescriptionText`); blank when there is none (nothing like "Description not yet available" is printed). The JCRC row's description is "The elected student committee that leads the hall. See the JCRC page." There are no footnote superscripts. The Explanatory notes page is gone: the document ends, after the last page (the JCRC page when present), with one closing block (the "Sem 1 / Sem 2: involvement for that semester only." key only when a part-year item appears, About this record, "— END OF TRANSCRIPT —"). Print: every row stays whole, a CCA row never separates from its first activity row, and the closing block stays together. Other involvement, Volunteer hours, Awards and the JCRC page keep their structure.
