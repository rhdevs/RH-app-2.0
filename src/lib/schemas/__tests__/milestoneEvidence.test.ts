import { describe, expect, it } from "vitest";

import {
  EVIDENCE_CONTENT_TYPES,
  evidenceFolder,
  evidencePathFromUrl,
  evidenceUploadPath,
  parseEvidencePath,
  privateStoreHost,
} from "../milestoneEvidence";

const HOST = privateStoreHost("AbC123Store");
const GOOD = "milestone-evidence/9803/evidence-Xk29aLmQ.webp";
const url = (path: string, host = HOST) => `https://${host}/${path}`;

describe("the allowed types", () => {
  it("are the three image types, and never SVG", () => {
    expect([...EVIDENCE_CONTENT_TYPES]).toEqual([
      "image/webp",
      "image/png",
      "image/jpeg",
    ]);
    expect(EVIDENCE_CONTENT_TYPES.join(" ")).not.toMatch(/svg/i);
    expect(
      parseEvidencePath("milestone-evidence/9803/evidence.svg"),
    ).toBeNull();
  });
});

describe("evidenceUploadPath and evidenceFolder", () => {
  it("name the server's folder for the CCA", () => {
    expect(evidenceFolder(9803)).toBe("milestone-evidence/9803/");
    expect(evidenceUploadPath(9803, "webp")).toBe(
      "milestone-evidence/9803/evidence.webp",
    );
    expect(parseEvidencePath(evidenceUploadPath(9803, "jpg"))).toMatchObject({
      ccaID: 9803,
      name: "evidence",
      contentType: "image/jpeg",
    });
  });
});

describe("parseEvidencePath", () => {
  it("reads the CCA, name and type of a well-formed pathname", () => {
    expect(parseEvidencePath(GOOD)).toEqual({
      ccaID: 9803,
      name: "evidence-Xk29aLmQ",
      ext: "webp",
      contentType: "image/webp",
    });
    expect(parseEvidencePath("milestone-evidence/7/a_b-c.png")).toMatchObject({
      ccaID: 7,
      contentType: "image/png",
    });
  });

  it.each([
    ["another folder", "proposal/9803/evidence.webp"],
    ["a public event image", "event/9803/evidence.webp"],
    ["a leading slash", "/milestone-evidence/9803/evidence.webp"],
    ["a nested folder", "milestone-evidence/9803/x/evidence.webp"],
    ["a parent segment", "milestone-evidence/9803/../1/evidence.webp"],
    [
      "a parent segment in the CCA place",
      "milestone-evidence/../evidence.webp",
    ],
    ["a dot segment", "milestone-evidence/9803/./evidence.webp"],
    ["a name that is only dots", "milestone-evidence/9803/...webp"],
    ["a double extension", "milestone-evidence/9803/evidence.php.webp"],
    ["an upper-case extension", "milestone-evidence/9803/evidence.WEBP"],
    ["a gif", "milestone-evidence/9803/evidence.gif"],
    ["no extension", "milestone-evidence/9803/evidence"],
    ["a zero CCA", "milestone-evidence/0/evidence.webp"],
    ["a CCA with a leading zero", "milestone-evidence/09803/evidence.webp"],
    ["a signed CCA", "milestone-evidence/-1/evidence.webp"],
    ["an encoded slash", "milestone-evidence/9803/a%2Fb.webp"],
    ["an encoded dot", "milestone-evidence/9803/%2e%2e.webp"],
    ["a backslash", "milestone-evidence\\9803\\evidence.webp"],
    ["a question mark", "milestone-evidence/9803/evidence.webp?x=1"],
    ["a hash", "milestone-evidence/9803/evidence.webp#x"],
    ["a newline", "milestone-evidence/9803/evidence.webp\n"],
    ["a space", "milestone-evidence/9803/evi dence.webp"],
    [
      "a name that is too long",
      `milestone-evidence/9803/${"a".repeat(81)}.webp`,
    ],
    ["a name that starts with a dash", "milestone-evidence/9803/-a.webp"],
    ["nothing", ""],
  ])("refuses %s", (_name, path) => {
    expect(parseEvidencePath(path)).toBeNull();
  });
});

describe("evidencePathFromUrl", () => {
  it("returns the pathname of an address in our private store", () => {
    expect(evidencePathFromUrl(url(GOOD), HOST)).toBe(GOOD);
  });

  it("accepts the host in any letter case, since host names are not case-sensitive", () => {
    expect(evidencePathFromUrl(url(GOOD, HOST.toUpperCase()), HOST)).toBe(GOOD);
  });

  it.each([
    [
      "the public store",
      url(GOOD, "abc123store.public.blob.vercel-storage.com"),
    ],
    ["another private store", url(GOOD, privateStoreHost("other"))],
    ["a look-alike host", url(GOOD, `${HOST}.evil.test`)],
    ["a host with the store as a prefix", url(GOOD, `x${HOST}`)],
    ["plain http", `http://${HOST}/${GOOD}`],
    ["credentials", `https://user:pw@${HOST}/${GOOD}`],
    ["a port", `https://${HOST}:8443/${GOOD}`],
    ["a query string", `${url(GOOD)}?download=1`],
    ["an empty query string", `${url(GOOD)}?`],
    ["a fragment", `${url(GOOD)}#frag`],
    ["an empty fragment", `${url(GOOD)}#`],
    [
      "a query smuggled before the extension",
      url("milestone-evidence/9803/evidence?.webp"),
    ],
    [
      "a parent segment that cancels out",
      url("proposal/../milestone-evidence/9803/evidence-x.webp"),
    ],
    [
      "a parent segment inside",
      url("milestone-evidence/9803/../9804/evidence-x.webp"),
    ],
    ["a dot segment", url("milestone-evidence/./9803/evidence-x.webp")],
    ["a doubled slash", url("milestone-evidence//9803/evidence-x.webp")],
    ["an encoded slash", url("milestone-evidence/9803/a%2Fb.webp")],
    [
      "an encoded dot dot",
      url("milestone-evidence/9803/%2e%2e/evidence-x.webp"),
    ],
    ["an encoded percent", url("milestone-evidence/9803/a%25b.webp")],
    ["a backslash", `https://${HOST}\\${GOOD}`],
    ["a path outside the evidence folder", url("cca/logo.webp")],
    ["a CCA-less path", url("milestone-evidence/evidence.webp")],
    ["whitespace around it", ` ${url(GOOD)}`],
    ["a newline inside", url("milestone-evidence/9803/evi\ndence.webp")],
    ["no path", `https://${HOST}`],
    ["a bare pathname", GOOD],
    ["a relative address", `/${GOOD}`],
    ["a javascript address", "javascript:alert(1)"],
    ["nothing", ""],
  ])("refuses %s", (_name, address) => {
    expect(evidencePathFromUrl(address, HOST)).toBeNull();
  });

  it("refuses an address longer than any real one", () => {
    expect(
      evidencePathFromUrl(
        url(`milestone-evidence/9803/${"a".repeat(3000)}.webp`),
        HOST,
      ),
    ).toBeNull();
  });
});
