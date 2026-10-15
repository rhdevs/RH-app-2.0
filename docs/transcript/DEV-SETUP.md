# Transcript: local database setup

Phase 3 runs against a local single-node MongoDB replica set in Docker. Nothing here touches a shared or production database.

## Safety rules

- **Localhost only.** The container binds `127.0.0.1:27017`, and `DATABASE_URL` must point at `localhost` or `127.0.0.1`.
- **A distinct database name:** `rhapp_transcript_dev`, never `rhapp`. The seed script refuses to run against any other host or name.
- Never run `prisma db push --accept-data-loss` or `--force-reset`, and never run any Prisma command against a non-local URL.
- `.env` is gitignored. Never commit it.

## One-time setup

Docker Desktop must be running.

```bash
npm ci
```

Create `.env` (copy `.env.example`) and set:

```text
DATABASE_URL="mongodb://localhost:27017/rhapp_transcript_dev?replicaSet=rs0&directConnection=true"
```

The other variables can be placeholders for local work (the build needs `NEXTAUTH_URL` and `RESEND_API_KEY` to be set to something).

## Everyday commands

| Task | Command |
| --- | --- |
| Start the database (first run also initiates the replica set) | `npm run dev:db:up` |
| Stop it (data is kept in the `rhapp-transcript-mongo-data` volume) | `npm run dev:db:down` |
| Create the collections and indexes | `npx prisma db push` |
| Fill it with fake data (idempotent) | `npm run dev:db:seed` |
| Start the app | `npm run dev` |

Order on a fresh machine: `dev:db:up`, then `npx prisma db push`, then `dev:db:seed`.

## Reset

To wipe everything and start again:

```bash
npm run dev:db:down
docker volume rm dev_rhapp-transcript-mongo-data
npm run dev:db:up
npx prisma db push
npm run dev:db:seed
```

(The volume name is prefixed with the compose project name, `dev`; `docker volume ls` shows it.) To reseed only, just run `npm run dev:db:seed` again: it deletes and re-inserts its own `SEED-` documents.

## What the seed creates

Fake data for `AY2026/27`: 14 CCAs (including the four "RVC ..." volunteering CCAs), 20 made-up residents (`SEED-R01` to `SEED-R20`) with admin, JCRC, CCA head and resident roles, memberships (one resident in 13 CCAs), accepted applications before and after the 2027-01-11 semester-2 start, roster entries (sem1-only, sem2-only, a head whose role starts in sem2), volunteer records, awards, and JCRC service for two members.

## A caveat

The local database has no `$jsonSchema` validators (production's CCA, UserCCA and User do). The seed writes only the fields those models declare, so it matches what production would accept, but the local database will not stop you writing a bad field.

## Integration tests (`npm run test:db`)

`npm run test` needs no database: the integration tests in `src/server/api/services/transcript/__tests__/transcript.int.test.ts` are skipped unless `DATABASE_URL` points at `localhost` and the database is `rhapp_transcript_dev`.

```bash
npm run dev:db:up
npx prisma db push
npm run test:db
```

`test:db` loads `.env` (Node's `--env-file`) and runs only the `*.int.test.ts` files. The suite re-runs the seed script first to get a known baseline, and before each test restores the period, the roster annotations and the issued transcripts. It temporarily edits one seeded CcaHead date and one seeded UserCCA row and puts them back. Run it after any change to `periods.ts`, `loader.ts`, `issue.ts` or the router.

## Signing in locally

Every seeded resident can sign in at `/login` with email and password. All of them share one development password:

```text
Transcript-Dev-2026
```

It works only against the local `rhapp_transcript_dev` database (the seed refuses any other). The emails are `seed-rNN@u.nus.edu`: that is an address the app's sign-in rule admits, and its canonical id (`SEED-RNN`) is exactly the key the seeded data is filed under. Nothing is ever sent to them. Re-run `npm run dev:db:seed` after pulling to refresh the accounts.

| Email | Role | Notes |
| --- | --- | --- |
| `seed-r01@u.nus.edu` | admin | |
| `seed-r02@u.nus.edu` | JCRC member | Sports Secretary; not a CCA head |
| `seed-r03@u.nus.edu` | JCRC member and CCA head | Heads RHMP Sets (a normal CCA) |
| `seed-r04@u.nus.edu` | head of a normal CCA | Heads Soccer (MALE) |
| `seed-r05@u.nus.edu` | head of a normal CCA | Heads Hall Choir; took over in semester 2 |
| `seed-r06@u.nus.edu` | head of a volunteering CCA | Heads RVC Children |
| `seed-r07@u.nus.edu` | head of a volunteering CCA | Heads RVC Special Projects |
| `seed-r10@u.nus.edu` | head of a volunteering CCA | Heads RVC Pioneers |
| `seed-r11@u.nus.edu` | head of a volunteering CCA | Heads RVC Special Needs |
| `seed-r08@u.nus.edu` | head of a normal CCA | Heads Phoenix Press |
| `seed-r12@u.nus.edu` | plain member | In 13 CCAs; has volunteering, awards and part-year memberships |
| `seed-r09@u.nus.edu`, `seed-r13@u.nus.edu` to `seed-r20@u.nus.edu` | plain member | A few CCAs each |

A caveat: the addresses end in `@u.nus.edu`, the real NUS student domain, so they could in principle collide with a real mailbox if someone triggered a password reset against a database with a real mail key. Keep `RESEND_API_KEY` a placeholder locally.

## Manual check: admin screens (Phase 3f)

Start with `npm run dev:db:up`, `npm run dev:db:seed`, `npm run dev`. Sign in at `/login` with the password above.

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| Gate | `seed-r04` (head), then `seed-r15` (plain member) | Open `/admin/transcripts` | Sent back to `/admin` or `/`; no Transcripts tab |
| Academic year | `seed-r01` (admin) or `seed-r02` (JCRC) | Clear the date, press Publish | Error asking for the semester 2 date. Enter 12 Jan 2027, Save, Publish, confirm: status Published and "N members frozen, 0 rows could not be matched". Reopen, confirm: status Collecting. |
| Volunteering CCAs | same | Flip a switch, reload | Change persists; the four RVC CCAs start on |
| Awards | same | Add an award for `SEED-R12`, then void it | Appears, then disappears; "Show voided" brings it back. Locked while Published |
| Preview | same | Pick a resident (3+ letters), open preview | Template C with the Preview bar; JCRC page only for `seed-r02`/`seed-r03`; no issue is created |

Re-run `npm run dev:db:seed` afterwards to return the year to Collecting.

## Manual check: head and JCRC screens (Phase 3g)

The app's profile gate sends a seeded account to `/profile` until its profile (name, Telegram, block) is completed. Complete it once per account you sign in with, then use the pages below.

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| Head tab, normal CCA | `seed-r04` (Soccer) | CCA dashboard, "Transcript" | Member roster table, no volunteer hours section. Set a member to "Semester 2 only", type a role and a contribution, press that row's Save: "Saved". The counter under the contribution counts down from 500. |
| Head tab, another CCA | `seed-r04` | Open `/cca/9002/transcript` | "You do not head this CCA." |
| Head tab, volunteering CCA | `seed-r06` (RVC Children) | "Transcript" | Roster and a Volunteer hours section. Search "Seed", choose a resident, add a one-off (date inside the year, hours in quarters). It appears in the list and the totals. Void asks first. |
| Published year | `seed-r01`, then `seed-r04` | Publish at `/admin/transcripts`, then reload the head tab | The published note, every field read-only. Reopen to restore. |
| JCRC self page | `seed-r02` | `/admin/transcripts`, "Your JCRC page" | Fields, the placeholder note, "Preview my transcript". Save, then preview: the JCRC page shows your text. |
| JCRC page, admin only | `seed-r01` | `/admin/transcripts/jcrc` | "Only JCRC members have a JCRC page." |
| Preview print | `seed-r01` | Preview a resident, print or save as PDF | Only the transcript prints: no header or tabs, crest and footer on every page. |

Run `npm run dev:db:seed` afterwards to restore the seeded state.
