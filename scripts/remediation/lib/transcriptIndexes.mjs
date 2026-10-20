/**
 * Read-only check that the unique indexes the Transcript feature relies on
 * exist. `db` is anything with `$runCommandRaw(cmd)`. A read that fails or
 * answers not-ok counts as "missing": an unanswered question is not "present".
 * Returns `{ ok, problems }`, one line per missing or different index.
 */
const sameKey = (a, b) =>
  JSON.stringify(Object.entries(a ?? {})) ===
  JSON.stringify(Object.entries(b ?? {}));

export async function checkUniqueIndexes(db, targets) {
  const problems = [];
  for (const [coll, wanted] of Object.entries(targets)) {
    const uniques = wanted.filter((ix) => ix.unique);
    if (uniques.length === 0) continue;
    let existing = [];
    try {
      const reply = await db.$runCommandRaw({ listIndexes: coll });
      existing = reply?.cursor?.firstBatch ?? [];
    } catch {
      // collection absent or unreadable: every unique index is missing
    }
    for (const ix of uniques) {
      const found = existing.find(
        (i) =>
          i?.name === ix.name && sameKey(i.key, ix.key) && i.unique === true,
      );
      if (!found) {
        problems.push(
          `${coll}.${ix.name} ${JSON.stringify(ix.key)} unique: missing or different`,
        );
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
