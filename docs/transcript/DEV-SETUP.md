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

Fake data for `AY2026/27`: 14 CCAs (including the four "RVC ..." volunteering CCAs), 20 made-up residents (`SEED-R01` to `SEED-R20`) with admin, JCRC, CCA head and resident roles, memberships (one resident in 13 CCAs), accepted applications before and after the 2027-01-11 semester-2 start, roster entries (sem1-only, sem2-only, a head whose role starts in sem2), volunteer activities, awards, JCRC service for two members, and CCA activities (Soccer: a full-year league that `SEED-R20`, who is not in Soccer, also took part in; Hall Choir: a semester 2 activity; RVC Children: one live activity and one removed).

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

## Manual check: click-through fixes

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| Header entry | `seed-r12` | Open the profile menu (desktop), then the menu (phone) | "My transcript" directly under "My applications". No badge while the year is collecting. After `seed-r01` publishes the year: a "Ready" badge beside it and a dot on the profile button. Open the transcript: both go away. |
| Download-by banner | `seed-r01`, then `seed-r12` | Academic year panel: set Download by, Save, publish. Open `/transcript` as the resident | "Download your AY2026/27 transcript before 31 Dec 2027." (the seeded date). Clear the date: no banner. |
| Volunteering CCAs | `seed-r01` | `/admin/transcripts`, Volunteering CCAs | Only the four RVC CCAs, "4 volunteering CCAs". Type "soc", add Soccer: it joins the list. Remove it: a confirmation says hours already recorded stay. |
| JCRC contributions | `seed-r02` | `/admin/transcripts/jcrc` | One card per contribution with counters. Move up and down, Remove (shows "Removed. Undo"), Undo, Add contribution ("N of 10"), Save. Preview: an Activity / Role / Description table. |
| Role period | `seed-r04` | `/cca/9005/transcript`, give a member a role | With a semester 2 membership the role period offers only the default and "Semester 2 only". Narrow a full-year member who has a full-year role: the role period changes with a one-line note. |
| Picker | `seed-r06` | Volunteer hours, search "Seed" | Placeholder "Name". Arrow keys move, Enter picks, Escape closes. As `seed-r01` the placeholder is "Name, email or matric". |
| Names | `seed-r01` | Publish, add and void an award | "Published on ... by Seed Resident 01", "Recorded by ... Voided by ..." show names, not SEED- keys. |
| Phone | any | `/transcript/preview/many-ccas` at 375 px wide | No horizontal scroll; the Year column stays on one line. |

Run `npm run dev:db:seed` afterwards to restore the seeded state. If `prisma db push` complains about old local TranscriptIssue or JcrcService documents (their shapes changed), drop the local TranscriptIssue collection and delete the local JcrcService documents first, then re-seed.

## Manual check: year lifecycle and handover freeze

The seed freezes two CCAs for AY2026/27 so the admin table shows each state: "Raffles Hall Dance" (id 9014) at handover and "Hall Choir" (9013) locked by its head. Everything else is not frozen.

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| Handover warning | `seed-r04` (Soccer head) | CCA dashboard, Overview, Hand over | An amber note: finish this year's transcript records; handing over freezes the member list for AY2026/27; link "Open transcript records". |
| Handover freezes | `seed-r04` | Hand over to `seed-r09` | `/cca` closes for you. As `seed-r01`, the table shows Soccer "Frozen at handover", dated today, by Seed Resident 04. |
| Admin removes a head | `seed-r01` | Admin, CCAs: remove or transfer a head | The CCA shows "Head removed" in the table. Adding a head does not freeze. |
| Lock | a head | Transcript tab, "Lock member list for AY2026/27", confirm | Table: "Locked by head". The head can still edit roles, contributions and hours. |
| Frozen is read-only | a head of a handover-frozen CCA | Transcript tab | "Frozen on {date}. Ask the JCRC for changes." and every field is read-only. `seed-r02` can still edit. |
| 1 June warning | `seed-r01` | Academic year section after 1 June | "N CCAs are not frozen for AY2026/27 yet. Close the year before memberships change." |
| Close year | `seed-r01` | Close year, confirm (it states how many CCAs it will freeze) | Status Closed; every CCA frozen; only Publish and Back to collecting are offered. Without a semester 2 date it refuses. |
| Draft view | `seed-r12` | `/transcript` while closed | "Draft - check your information..." on page 1, DRAFT across every page, also when printed. No "Ready" badge, no banner. |
| Publish | `seed-r01` | Publish | Residents get a Ready badge; the draft note is gone. Only "Reopen for review" is offered. |
| Reopen / back | `seed-r01` | Reopen for review, then Back to collecting | Closed again (residents see a draft), then Collecting. Frozen lists stay frozen. |
| Unfreeze | `seed-r01` | Unfreeze on a CCA, give a reason | The CCA reads "Not frozen"; its current members are used until it is frozen again. Not offered once published. |

Dev only: `/transcript/preview/plain-member?draft=1` shows a specimen as the draft.

Run `npm run dev:db:seed` afterwards to restore the seeded state. After pulling this change, `prisma db push` adds the `CcaYearFreeze` collection and its index.

## Manual check: CCA activities and the roster editor

The seed gives AY2026/27 four activities: Soccer (9005, head `seed-r04`) "Inter-hall league" with `seed-r04` (Captain), `seed-r12` and `seed-r20` (not in Soccer); Hall Choir (9007, head `seed-r05`) "Hall Night preparation" in semester 2; RVC Children (9002, head `seed-r06`) "Exam-period care packs" and a removed "Cancelled workshop". After pulling this change, `prisma db push` adds the `CcaActivity` and `CcaActivityParticipant` collections and the `closedAt`, `closedBy`, `backToCollectingAt` and `backToCollectingBy` fields on the period.

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| Activities section | `seed-r04` | `/cca/9005/transcript` | "Activities" above the roster, "1 of 20", Add activity, and "Inter-hall league" with Edit and Remove. |
| Add an activity | `seed-r04` | Add activity, fill the title, tick members, Add activity | The dialog closes and the list shows "2 of 20". On a phone the editor fills the screen. |
| Filter and tick | `seed-r04` | In the editor, type part of a name, Select all, Clear all | Only matching members show; the two buttons act on those only. "N people selected" follows. |
| Outside people | `seed-r04` | In the editor, search `Seed` under "Other people", pick one | A chip appears; the x removes it. Heads search by name only. |
| Customise | `seed-r04` | "Customise each person" | A Role and Description per person with the two placeholders; empty means the general description. |
| Remove and restore | `seed-r04` | Remove, confirm; tick Show removed; Restore | It leaves the count and the transcripts; Restore brings it back. At 20 activities Add and Restore are refused. |
| On a transcript | `seed-r12` and `seed-r20` | Preview as resident (`seed-r01`), AY2026/27 | `seed-r12`: the league nested under Soccer. `seed-r20`: "Other involvement" with the league and "Organised by Soccer (MALE)". |
| Frozen is read-only | `seed-r04` | After a handover, `/cca/9005/transcript` | The Activities section shows the frozen note and no buttons. `seed-r02` can still edit. |
| Unsaved changes | any head | Edit two roster rows, change the year | A sticky bar says "2 unsaved changes"; Save all saves both; Discard asks first; changing the year asks before leaving. |
| Phone roster | any head | Roster at 375 px wide | Cards instead of a table, a name filter, and no horizontal scroll. |

Dev only: `/transcript/preview/member-with-activities` and `/transcript/preview/other-involvement-only` show specimens 13 and 14.

Run `npm run dev:db:seed` afterwards to restore the seeded state.

## Manual check: volunteer activities

The seed gives AY2026/27 two RVC activities. RVC Children (9002, head `seed-r06`): "Weekly tuition for neighbourhood children", 10 weekly sessions of 2 hours from 7 September, the CCA's members plus one outsider as people, `seed-r12` ticked in every session (one with their own 1 hour, so 19 hours). RVC Special Projects (9001, head `seed-r07`): a one-off "Beach clean-up, East Coast Park" of 4 hours. A removed "Cancelled food drive" must never appear on a transcript. After pulling this change, `prisma db push` adds the four volunteer collections; the old `VolunteerRecord` collection is simply no longer used (the seed drops it locally).

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| The section | `seed-r06` | `/cca/9002/transcript` | "Volunteer hours" with "1 of 30", Add volunteer activity, and the tuition activity with its people and total hours. `seed-r04` (Soccer) has no such section. |
| Create | `seed-r06` | Add volunteer activity, type a title, tick members, add someone outside the CCA, Add | The list shows "2 of 30". On a phone the editor fills the screen. |
| Add a session | `seed-r06` | Attendance on the new activity, Add session | The first session is today; the next is a week after the latest, with the same hours. |
| Grid ticks | `seed-r06` | Click cells; Tick all, Clear all on a column; Tick all sessions on a row | Cells fill, totals update live, the bar says "N unsaved changes". Save stores them; Discard asks nothing and throws them away. |
| Copy previous | `seed-r06` | On a later column, Copy previous | That column's ticks match the session before it (not its overrides). |
| Override | `seed-r06` | "h" on a ticked cell, type 1.5, Enter | The cell shows 1.5 and the person's total follows; clearing the box goes back to the session's hours. |
| Paging | `seed-r06` | The tuition grid | At most 8 session columns, with Earlier sessions / Later sessions. |
| Phone view | `seed-r06` | The attendance panel at 375 px wide | One session at a time with arrows and a date selector, Tick all, Clear all, Copy previous session, an hours box for each ticked person. |
| Edit a session | `seed-r06` | Edit session on a column | Change the date or hours, or Remove session; a removed session stops counting. |
| One-off | `seed-r07` | The beach clean-up | Same editor with a date and hours, no Add session; the grid has one column. |
| Remove and restore | `seed-r06` | Remove, confirm; Show removed; Restore | It leaves the transcripts and the count; Restore brings it back. At 30 activities Add and Restore are refused. |
| On a transcript | `seed-r01` | Preview as resident `seed-r12`, AY2026/27 | "Volunteer hours": Activity, Type, Organised by, Hours; tuition 19 (Regular, RVC Children), beach clean-up 4 (One-off, RVC Special Projects), Total 23. No session counts. |
| Unsaved changes | `seed-r06` | Tick cells, then open another activity or reload | The browser or an in-app prompt asks before leaving. |

Run `npm run dev:db:seed` afterwards to restore the seeded state.

## Manual check: awards

The seed gives a catalogue of five awards (Colours Award, Soccer; Service Excellence Award; Outstanding Newcomer; Full Colours; Retired Award, archived), the awards `seed-r04` and `seed-r12` already had, and one upload, "colours-2026.csv", whose three "Full Colours" awards belong to `seed-r13` to `seed-r15`. After pulling this change, `prisma db push` adds `AwardType` and `AwardImportBatch` and the new `Award` fields and index. Only admin and JCRC can open `/admin/transcripts/awards`; `seed-r04` is sent back to `/admin`.

| Screen | Sign in as | What to click | Expect |
| --- | --- | --- | --- |
| The link | `seed-r01` | `/admin/transcripts` | The Awards section is a short count ("7 awards for AY2026/27") with "Manage awards". |
| Awards tab | `seed-r02` | `/admin/transcripts/awards` | "Assign an award", then the year's awards grouped: "Full Colours: 3 residents" and so on, collapsed. |
| Group and search | `seed-r02` | Open a group; type `colours`; turn "Group by award" off | The people and citations show; search opens every group; off gives one flat list naming each award. |
| Assign | `seed-r02` | Choose "Full Colours", add `seed-r13` and `seed-r20` as chips, Assign | "1 assigned. Skipped (already have it): Seed Resident 13." Typing a citation for a person overrides the default. |
| New award | `seed-r02` | Choose "New award", name it, add someone, Assign | The award is created in the catalogue and assigned. A name that clashes (any case or spacing) is refused. |
| Edit and remove | `seed-r02` | Edit a row, change the title and citation, Save; Remove; Show removed; Restore | The row changes; a removed row is struck through and can be restored. |
| Bulk | `seed-r02` | Tick several rows or a group, Remove selected, confirm; Restore selected | A confirmation first; a restore skips anyone who now has the award again and names them. |
| Catalogue | `seed-r02` | Catalogue tab: add, edit, Archive, Show archived, Restore | An archived award disappears from "Assign an award" but its awards stay on transcripts; renaming leaves past awards' names alone. |
| History | `seed-r02` | History tab, Undo on "colours-2026.csv", confirm | "3 awards removed."; the three "Full Colours" awards are gone from the Awards tab (Show removed shows them); Undo is no longer offered. |
| Published | `seed-r01` | Publish the year, open the page | A note that changes are locked; the Awards and History tabs are read-only; the Catalogue still works. |
| On a transcript | `seed-r01` | Preview as resident `seed-r04` | "Award | Year": "Colours Award, Soccer", 2026/27, and the citation in small italics beneath. |
| Roster layout | `seed-r04` | `/cca/9005/transcript` at 1280px | The roster is cards (the column beside the side menu is narrower than the table needs); on a wider screen the table shows with Save fixed at the right edge. |

Run `npm run dev:db:seed` afterwards to restore the seeded state.
