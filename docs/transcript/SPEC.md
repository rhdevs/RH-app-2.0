# Transcript — Design and Data-Model Spec

> **Current design:** verification, the QR code, issuing and stored snapshots were removed. Where an earlier section describes them, section 22 supersedes it.

**Ask:** Each resident can download a generated end-of-Academic-Year (AY) transcript of their hall involvements, to (1) recognise their efforts and (2) formalise their involvements. Style target: an NUS Student Development Transcript.

**Scope:** Phase 1 only. This document is a proposal; **nothing below is implemented**. No code, schema or dependency is changed by this PR.

**Status:** proposal, draft for review. Open questions are in section 10.

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
- **Per-year records:** each year has its own issue (verification code, issue date, block, year of residence). Block and year of residence are shown because #113 already models them; faculty is not shown.
- **JCRC:** one `JcrcServiceInput` per resident, applied only to the year in its `term`. The JCRC appointment is the first row of the table and is counted as a leadership role, not as a CCA. All JCRC content is placeholder data.
- **Signatures:** never data. The JCRC page always prints two empty boxes labelled "[Master signature placeholder]" and "[President signature placeholder]", each with a date placeholder, and never a person's name.
- **Footer:** the resident name and matric are a plain `position: fixed` element pinned to the bottom of the content area, so every browser repeats it on every printed page; each sheet ends in a repeating empty table footer that reserves its space, so body text never prints under it. "Page X of Y" is progressive enhancement, an `@page` margin box counted by the browser (Chrome 131 or later); a browser without margin boxes prints the name but no page numbers. The name is not also in a margin box, so Chrome never prints it twice. On screen each page shows its own footer.
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

**Block and year of residence.** The app keeps no residence history, so `yearOfResidence` is now optional and the loader leaves it null; the document prints whichever of block and year is known.

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
- **JCRC contributions** are structured rows `{activity (80, required), role (60), description (300)}`, at most 10, stored as a composite type on `JcrcService`. The editor has a card per row with counters, Move up / Move down, Remove (shown as "Removed. Undo" until Save) and "N of 10". The JCRC page prints them as an Activity | Role | Description table.
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
- **Publish** (from closed only): freezes nothing.
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

**Limits.** Title 1 to 80 characters, description up to 300, period `full | sem1 | sem2`. At most 20 activities that are not removed per CCA per year, and at most 200 participants per activity. A participant's role is up to 60 characters and their description up to 300. Text follows the same plain-text rules as the rest of the transcript (control and invisible characters are rejected).

**Soft removal.** Nothing is deleted. Removing an activity sets `removedAt/By`; removing a participant (by leaving them out of `participants.set`) does the same. A removed activity or participant never renders. Restoring an activity is refused if it would take the CCA over 20. A person who was removed and is listed again gets their old row back (one row per person per activity).

**API** (`transcriptManage`). `activities.list` (with `includeRemoved`), `activities.create`, `activities.update`, `activities.remove`, `activities.restore`, and `participants.set`. `participants.set` REPLACES the activity's active people with the list given, in one transaction: new people are added, missing ones are soft-removed, and a row is rewritten only if its role or description changed. Each person must be an existing resident (anyone in the hall, not only members of the CCA); a duplicate or unknown person refuses the whole call and changes nothing. Every procedure checks the caller heads this CCA (or is a manager); every write then runs the one edit guard (`assertCanEditCcaYear`) for the activity's own year: nobody once published, managers while collecting or closed, the head only while collecting and not frozen at handover (or frozen by their own lock). An activity can be read through its own CCA only; another CCA's id is "not found". The actor and time are recorded, shown as display names.

**Who can search for people to add.** `residents.search` now admits a manager or the head of ANY CCA (it was volunteering CCAs only), so a head can add someone from outside the CCA. A head who is not a manager still searches by display name only, with the same masked matric, 10 hits and 60 requests per 10 minutes. Anyone else gets `NOT_A_CCA_HEAD`.

**On the transcript.** Membership uses the same rule as the CCA rows: the frozen list when the CCA has an active freeze for the year, otherwise the live roster when the year is the CCA's term year. A member's activities for that CCA nest under its row as an "Activity | Role | Description" table, ordered full year, semester 1, semester 2, then by title. A part-year activity reads "Title (Sem 1)" / "Title (Sem 2)". The description is the person's own, else the activity's general one, else blank; a blank role stays blank. If the CCA also has an additional contribution it is the last row of that table ("Additional contribution"); a CCA with no activities keeps its single "Additional contribution:" line. Activities of a CCA the person is not a member of go under a section "Other involvement" (Activity | Organised by | Role | Description), after the CCA section and before Volunteer hours; it is left out when empty, and a transcript with only that section is not an empty year. The notes page lists each activity's general description as "Activity: description" under its CCA's note, and "Notes on other involvement" lists the others. Sem 1 / Sem 2 is explained there when any activity is part-year.

**Head screen** (`/cca/[ccaID]/transcript`). An "Activities" section above the roster: "N of 20", Add activity, each activity with Edit and Remove (confirmation), and Show removed with Restore. The editor is a dialog on a desktop and a full-screen sheet on a phone: title, period, description with counters, a tick list of the CCA's members (name filter, Select all, Clear all, which act on the members the filter shows), a search to add people from outside the CCA (chips), and "Customise each person" for a role and description per person ("Leave empty if no role"; "What they did; leave empty to use the general description"). Saving writes the activity, then replaces its participants; if the second step fails the editor stays open on the saved activity so a retry makes no copy. The section is read-only, with the reason, when the head may not edit the year.

**Roster editor and unsaved changes.** Below the `md` breakpoint the roster is a list of cards (a table from `md`), with a name filter. While anything is unsaved a sticky bar shows "N unsaved changes" with Save all (one row after another; a failed row keeps its edit and shows its own message) and Discard; each row keeps its own Save. A shared hook, `useUnsavedChangesGuard(isDirty)`, asks the browser to confirm reloading or closing the tab and returns a `confirmLeave()` used before the year selector changes. It guards the roster editor, the activity editor, the JCRC page editor and the Academic year panel.
