/**
 * Where a script writes: the connection string's hosts and database, for the
 * scripts' "target:" line. PURE. No database, no env.
 */

/**
 * "host <hosts>, database <name>" for a MongoDB connection string: what this
 * run will write to, so a dry run and a commit both show it. Never the user
 * name or password (everything up to the last "@" of the authority is left
 * out), and never the query options.
 */
export function describeTarget(url) {
  if (!url) return "(DATABASE_URL is not set)";
  const start = url.indexOf("://");
  if (start < 0) return "(DATABASE_URL could not be read)";
  const rest = url.slice(start + 3);
  const end = rest.search(/[/?]/);
  const authority = end < 0 ? rest : rest.slice(0, end);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const rawName =
    end >= 0 && rest[end] === "/" ? rest.slice(end + 1).split("?")[0] : "";
  let name = rawName;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    // Shown as written.
  }
  return `host ${host || "(none)"}, database ${name || "(none: the default)"}`;
}
