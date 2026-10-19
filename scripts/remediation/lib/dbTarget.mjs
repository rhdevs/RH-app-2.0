/**
 * "host <hosts>, database <name>" for a MongoDB connection string: what a
 * script will write to, so a dry run and a commit both show it.
 *
 * Never the user name, the password, the options or the full URL. An "@" is
 * the end of the credentials only when it comes before any "/", "?" or "#", or
 * when what precedes the first of those cannot be a host (so "user:pa/ss@host"
 * is still read as credentials). Otherwise the "@" belongs to the path or the
 * options ("host/db?appName=a@b") and the host is what comes before the first
 * "/" or "?". When the two readings cannot be told apart ("admin:12345?x=1@h"
 * is a host with a port or a user with a numeric password), or an "@" is left
 * over after the credentials, nothing about the target is shown but "(host not
 * recognised)"; the same when any host does not look like one (a name or IP
 * literal, an optional port). A database name that does not look like one is
 * not shown either.
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
  const firstDelimiter = rest.search(/[/?#]/);
  let tail = rest;
  let credentialed = false;
  if (firstAt >= 0) {
    const beforeDelimiter = firstDelimiter < 0 || firstAt < firstDelimiter;
    const lead = firstDelimiter < 0 ? rest : rest.slice(0, firstDelimiter);
    const leadHosts = lead.split(",").map((h) => HOST.exec(h));
    const isHostList = leadHosts.every(Boolean);
    // A lead such as "admin:12345" is a host with a port or a user with a
    // password: the "@" after it cannot be placed.
    if (!beforeDelimiter && isHostList && leadHosts.some((m) => m?.[2])) {
      return "(host not recognised)";
    }
    credentialed = beforeDelimiter || !isHostList;
  }
  if (credentialed) {
    const slash = rest.indexOf("/", firstAt);
    if (slash < 0 && rest.indexOf("?", firstAt) >= 0) {
      // Options with no "/" before them: where the credentials end is unclear.
      return "(host not recognised)";
    }
    tail = rest.slice(
      rest.lastIndexOf("@", slash < 0 ? rest.length : slash) + 1,
    );
    // An "@" this reading does not account for: the target cannot be named.
    if (tail.includes("@")) return "(host not recognised)";
  }
  const hostEnd = tail.search(/[/?]/);
  const slash = hostEnd >= 0 && tail[hostEnd] === "/" ? hostEnd : -1;
  const hostList = hostEnd < 0 ? tail : tail.slice(0, hostEnd);
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
