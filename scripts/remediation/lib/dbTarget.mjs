/**
 * "host <hosts>, database <name>" for a MongoDB connection string: what a
 * script will write to, so a dry run and a commit both show it.
 *
 * Never the user name, the password, the options or the full URL. The hosts
 * are read after the LAST "@" before the options, so a password with an
 * unescaped "/" or "@" is not taken for a host, and every host must look like
 * one (a name or IP literal, an optional port). If any does not, nothing about
 * the target is shown but "(host not recognised)". A database name that does
 * not look like one is not shown either.
 *
 * PURE. No database, no env. Nothing in this file connects to anything.
 */

const HOST = /^(\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+)(:\d+)?$/i;
const DATABASE = /^[A-Za-z0-9_-]{1,64}$/;

export function describeTarget(url) {
  if (!url) return "(DATABASE_URL is not set)";
  const start = url.indexOf("://");
  if (start < 0) return "(DATABASE_URL could not be read)";
  // Up to the options: they are never shown, and may hold anything.
  const rest = url.slice(start + 3).split("?")[0];
  const afterCredentials = rest.slice(rest.lastIndexOf("@") + 1);
  const slash = afterCredentials.indexOf("/");
  const hostList =
    slash < 0 ? afterCredentials : afterCredentials.slice(0, slash);
  const hosts = hostList.split(",");
  if (!hostList || !hosts.every((h) => HOST.test(h))) {
    return "(host not recognised)";
  }
  let name = slash < 0 ? "" : afterCredentials.slice(slash + 1);
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
