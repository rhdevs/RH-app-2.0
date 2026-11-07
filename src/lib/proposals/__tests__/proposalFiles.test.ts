import { describe, expect, it } from "vitest";

import { CCA_BLOB_HOST } from "~/lib/schemas/cca";
import { eventUploadPath } from "~/lib/schemas/event";
import { proposalUpdateInput } from "~/lib/schemas/proposal";
import {
  isOwnProposalPosterUrl,
  normalizePosterUrl,
  normalizeDocLink,
  parseProposalUploadPath,
  proposalPosterPath,
  PROPOSAL_DOC_LINK_MAX,
} from "~/lib/schemas/proposalFiles";

const A = "0123456789abcdef01234567";
const B = "76543210fedcba9876543210";
const poster = (id: string, host = CCA_BLOB_HOST, tail = "-Xy7Qa1.webp") =>
  `https://${host}/${proposalPosterPath(id)}${tail}`;

describe("normalizeDocLink", () => {
  it("accepts a plain https link", () => {
    expect(normalizeDocLink("https://docs.example.com/plan?x=1")).toBe(
      "https://docs.example.com/plan?x=1",
    );
  });

  it("trims, and normalises the way the browser will read it", () => {
    expect(normalizeDocLink("  https://Docs.Example.com  ")).toBe(
      "https://docs.example.com/",
    );
  });

  it("refuses a javascript: link and other schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://example.com/a",
      "mailto:a@example.com",
    ]) {
      expect(normalizeDocLink(bad)).toBeNull();
    }
  });

  it("refuses http", () => {
    expect(normalizeDocLink("http://docs.example.com/plan")).toBeNull();
  });

  it("refuses embedded credentials", () => {
    expect(normalizeDocLink("https://user:pass@docs.example.com/")).toBeNull();
    expect(normalizeDocLink("https://user@docs.example.com/")).toBeNull();
    expect(normalizeDocLink("https://:pass@docs.example.com/")).toBeNull();
  });

  it("refuses a link over 2048 characters, and one that grows past it when normalised", () => {
    const prefix = "https://example.com/";
    expect(
      normalizeDocLink(
        prefix + "a".repeat(PROPOSAL_DOC_LINK_MAX - prefix.length),
      ),
    ).not.toBeNull();
    expect(
      normalizeDocLink(
        prefix + "a".repeat(PROPOSAL_DOC_LINK_MAX - prefix.length + 1),
      ),
    ).toBeNull();
    // 683 spaces-as-%20 stay short; a non-ASCII path is longer once encoded.
    expect(
      normalizeDocLink(prefix + "é".repeat(PROPOSAL_DOC_LINK_MAX / 2 - 30)),
    ).toBeNull();
  });

  it("refuses whitespace and control characters inside the link, and an empty one", () => {
    expect(normalizeDocLink("https://example.com/a b")).toBeNull();
    expect(normalizeDocLink("https://example.com/a\nb")).toBeNull();
    expect(normalizeDocLink("https://exa\tmple.com/")).toBeNull();
    expect(normalizeDocLink("")).toBeNull();
    expect(normalizeDocLink("   ")).toBeNull();
    expect(normalizeDocLink("https://")).toBeNull();
    expect(normalizeDocLink("not a url")).toBeNull();
  });
});

describe("isOwnProposalPosterUrl", () => {
  it("accepts this proposal's own poster address", () => {
    expect(isOwnProposalPosterUrl(poster(A), A)).toBe(true);
  });

  it("refuses the wrong host, a suffix of the host, and a look-alike host", () => {
    expect(isOwnProposalPosterUrl(poster(A, "evil.example.com"), A)).toBe(
      false,
    );
    expect(isOwnProposalPosterUrl(poster(A, `x.${CCA_BLOB_HOST}`), A)).toBe(
      false,
    );
    expect(
      isOwnProposalPosterUrl(poster(A, `${CCA_BLOB_HOST}.evil.com`), A),
    ).toBe(false);
    expect(isOwnProposalPosterUrl(poster(A, `${CCA_BLOB_HOST}:8443`), A)).toBe(
      false,
    );
  });

  it("refuses another proposal's prefix", () => {
    expect(isOwnProposalPosterUrl(poster(B), A)).toBe(false);
  });

  it("refuses an Event image, a CCA image and a path that only contains the prefix", () => {
    const base = `https://${CCA_BLOB_HOST}`;
    expect(
      isOwnProposalPosterUrl(
        `${base}/${eventUploadPath(12, "banner")}-a.webp`,
        A,
      ),
    ).toBe(false);
    expect(isOwnProposalPosterUrl(`${base}/cca/12/logo-a.webp`, A)).toBe(false);
    expect(
      isOwnProposalPosterUrl(`${base}/x/proposal/${A}/poster-a.webp`, A),
    ).toBe(false);
    expect(
      isOwnProposalPosterUrl(
        `${base}/proposal/${A}/poster/../../event/1/banner`,
        A,
      ),
    ).toBe(false);
    expect(
      isOwnProposalPosterUrl(`${base}/proposal/${A}/posterx/y.webp`, A),
    ).toBe(false);
  });

  it("refuses http, other schemes, credentials and junk", () => {
    expect(
      isOwnProposalPosterUrl(poster(A).replace("https:", "http:"), A),
    ).toBe(false);
    expect(isOwnProposalPosterUrl("javascript:alert(1)", A)).toBe(false);
    expect(
      isOwnProposalPosterUrl(poster(A).replace("https://", "https://u:p@"), A),
    ).toBe(false);
    expect(isOwnProposalPosterUrl("", A)).toBe(false);
    expect(isOwnProposalPosterUrl("not a url", A)).toBe(false);
    expect(isOwnProposalPosterUrl(poster(A), "not-an-id")).toBe(false);
  });
});

describe("parseProposalUploadPath", () => {
  it("reads only proposal/<id>/poster", () => {
    expect(parseProposalUploadPath(proposalPosterPath(A))).toEqual({
      proposalID: A,
    });
    for (const bad of [
      "",
      "event/12/banner",
      `proposal/${A}`,
      `proposal/${A}/photo`,
      `proposal/${A}/poster/x`,
      `/proposal/${A}/poster`,
      `proposal/short/poster`,
      `../proposal/${A}/poster`,
    ]) {
      expect(parseProposalUploadPath(bad)).toBeNull();
    }
  });
});

describe("the update schema's file fields", () => {
  const base = { id: A, version: 0 };

  it("takes this proposal's poster, a null to remove it, and a good link", () => {
    const parsed = proposalUpdateInput.parse({
      ...base,
      posterUrl: poster(A),
      docLink: " https://docs.example.com/plan ",
    });
    expect(parsed.posterUrl).toBe(poster(A));
    expect(parsed.docLink).toBe("https://docs.example.com/plan");
    expect(
      proposalUpdateInput.parse({ ...base, posterUrl: null, docLink: "  " }),
    ).toMatchObject({ posterUrl: null, docLink: null });
  });

  it("refuses another proposal's poster and an Event image as a poster", () => {
    expect(
      proposalUpdateInput.safeParse({ ...base, posterUrl: poster(B) }).success,
    ).toBe(false);
    expect(
      proposalUpdateInput.safeParse({
        ...base,
        posterUrl: `https://${CCA_BLOB_HOST}/${eventUploadPath(1, "banner")}-a.webp`,
      }).success,
    ).toBe(false);
  });

  it("refuses a bad link", () => {
    for (const docLink of [
      "javascript:alert(1)",
      "http://example.com",
      "https://u:p@example.com",
      "https://example.com/" + "a".repeat(PROPOSAL_DOC_LINK_MAX),
    ]) {
      expect(proposalUpdateInput.safeParse({ ...base, docLink }).success).toBe(
        false,
      );
    }
  });
});

describe("poster address spellings", () => {
  it("refuses a query string or a fragment, even an empty one", () => {
    for (const tail of ["#1", "?x", "?x=1", "#", "?"]) {
      expect(isOwnProposalPosterUrl(poster(A) + tail, A)).toBe(false);
      expect(normalizePosterUrl(poster(A) + tail, A)).toBeNull();
    }
  });

  it("is case-sensitive about the prefix, as blob keys are", () => {
    const upperId = `https://${CCA_BLOB_HOST}/proposal/${A.toUpperCase()}/poster-a.webp`;
    const upperDir = `https://${CCA_BLOB_HOST}/Proposal/${A}/poster-a.webp`;
    const upperName = `https://${CCA_BLOB_HOST}/proposal/${A}/POSTER-a.webp`;
    for (const u of [upperId, upperDir, upperName]) {
      expect(isOwnProposalPosterUrl(u, A)).toBe(false);
    }
    expect(
      parseProposalUploadPath(`proposal/${A.toUpperCase()}/poster`),
    ).toBeNull();
  });

  it("returns origin plus pathname, the same for the same blob", () => {
    expect(normalizePosterUrl(poster(A), A)).toBe(poster(A));
  });

  it("the update schema refuses #1 and ?x on the current address", () => {
    for (const tail of ["#1", "?x"]) {
      expect(
        proposalUpdateInput.safeParse({
          id: A,
          version: 0,
          posterUrl: poster(A) + tail,
        }).success,
      ).toBe(false);
    }
    expect(
      proposalUpdateInput.parse({ id: A, version: 0, posterUrl: poster(A) })
        .posterUrl,
    ).toBe(poster(A));
  });
});
