/**
 * "host <hosts>, database <name>" for a MongoDB connection string: what a
 * script will write to, so a dry run and a commit both show it.
 *
 * Never the user name, the password, the options or the full URL. The
 * credentials end at the last "@" before the first "/" that follows the first
 * "@" (so a password with an unescaped "/", "?" or "@" is not taken for a
 * host); the hosts run from there to the next "/", and only after that come
 * the database name and the options. An "@" anywhere after that boundary is
 * not accounted for by this reading, so nothing about the target is shown but
 * "(host not recognised)"; the same when any host does not look like one (a
 * name or IP literal, an optional port). A database name that does not look
 * like one is not shown either.
 *
 * PURE. No database, no env. Nothing in this file connects to anything.
 */

const HOST = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+)(:\d+)?$/i;
const DATABASE = /^[A-Za-z0-9_-]{1,64}$/;

export function describeTarget(url) {
  if (!url) return "(DATABASE_URL is not set)";
  const start = url.indexOf("://");
  if (start < 0) return "(DATABASE_URL could not be read)";
  const rest = url.slice(start + 3);
  const firstAt = rest.indexOf("@");
  let tail = rest;
  if (firstAt >= 0) {
    const slash = rest.indexOf("/", firstAt);
    if (slash < 0 && rest.indexOf("?", firstAt) >= 0) {
      // Options with no "/" before them: where the credentials end is unclear.
      return "(host not recognised)";
    }
    tail = rest.slice(
      rest.lastIndexOf("@", slash < 0 ? rest.length : slash) + 1,
    );
  }
  // An "@" this reading does not account for (in the hosts, the path or the
  // options): the target cannot be named safely.
  if (tail.includes("@")) return "(host not recognised)";
  const slash = tail.indexOf("/");
  const hostList = slash < 0 ? tail.split("?")[0] : tail.slice(0, slash);
  const hosts = hostList.split(",");
  if (!hostList || !hosts.every((h) => HOST.test(h))) {
    return "(host not recognised)";
  }
  let name = slash < 0 ? "" : tail.slice(slash + 1).split("?")[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // Checked as written.
  }
  const database =
    name === ""
      ? "(none: the default)"
      : DATABASE.test(name)
        ? name
        : "(not recognised)";
  return `host ${hosts.join(",")}, database ${database}`;
}
