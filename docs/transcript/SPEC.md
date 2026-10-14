# Transcript — Design and Data-Model Spec

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
- **Pages, in order:** page 1 (header, QR, resident row, summary strip, I. Leadership and CCA participation, II. Volunteer hours, III. Awards); the JCRC page (JCRC members only, always on a new printed page); the Explanatory notes page (numbered footnotes, "About this record", end marker). Empty sections are omitted. An empty year shows "No recorded involvements for this academic year."
- **Per-year records:** each year has its own issue (verification code, issue date, block, year of residence). Block and year of residence are shown because #113 already models them; faculty is not shown.
- **JCRC:** one `JcrcServiceInput` per resident, applied only to the year in its `term`. The JCRC appointment is the first row of the table and is counted as a leadership role, not as a CCA. All JCRC content is placeholder data.
- **Signatures:** never data. The JCRC page always prints two empty boxes labelled "[Master signature placeholder]" and "[President signature placeholder]", each with a date placeholder, and never a person's name.
- **Footer:** the browser counts pages. Print uses `@page` margin boxes (resident on the left, "Page X of Y" on the right), which need Chrome 131 or later; a browser without margin boxes prints no footer. On screen each page shows its own footer.
- **Page references:** the table says "See the Junior Common Room Committee page" rather than "See page 2", because page 1 can run to several printed pages for a resident in many CCAs.
- **Notes order:** footnotes follow the table (JCRC row, then leaders, then members alphabetically), not alphabetical order.
- **Single fixture source:** `src/lib/transcript/fixtures.ts` replaces `demoData.ts`. It holds twelve specimens, including a JCRC Sports Secretary (two years) and a JCRC member with no other CCAs.
- **Vitest 3, not 5:** `npm ci` fails with vitest 5 because of its optional `@types/node@22+` peer against the repo's `@types/node@20`. Vitest 3 resolves cleanly, and the lockfile diff against `upstream/main` is additions only.
