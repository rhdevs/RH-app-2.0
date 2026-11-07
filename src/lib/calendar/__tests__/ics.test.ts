import { describe, expect, it } from "vitest";

import {
  escapeIcsText,
  foldIcsLine,
  icsUid,
  icsUtc,
  writeIcs,
  type IcsEntry,
} from "../ics";

const octets = (s: string) => new TextEncoder().encode(s).length;
/** RFC 5545 unfolding: drop each CRLF followed by one space. */
const unfold = (s: string) => s.replace(/\r\n /g, "");

const entry = (over: Partial<IcsEntry> = {}): IcsEntry => ({
  uid: icsUid("event", 12),
  start: Date.UTC(2026, 10, 1, 0, 0, 0) / 1000,
  end: Date.UTC(2026, 10, 1, 2, 0, 0) / 1000,
  stamp: Date.UTC(2026, 9, 1) / 1000,
  summary: "[Drama] Showcase",
  status: "CONFIRMED",
  ...over,
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and newline", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
  });

  it("turns CRLF and a bare CR into one escaped newline each", () => {
    expect(escapeIcsText("a\r\nb\rc")).toBe("a\\nb\\nc");
  });

  it("escapes the backslash first so it is not doubled twice", () => {
    expect(escapeIcsText("\\,")).toBe("\\\\\\,");
  });

  it("drops control characters, so text cannot start a new property", () => {
    expect(escapeIcsText("a\u0000b\u0007c\u001bd\u007fe")).toBe("abcde");
  });

  it("cannot be used to inject a line", () => {
    const out = writeIcs({
      name: "RHApp",
      entries: [entry({ summary: "x\r\nATTENDEE:mailto:a@b.c" })],
    });
    expect(out).not.toContain("\r\nATTENDEE");
    expect(unfold(out)).toContain("SUMMARY:x\\nATTENDEE:mailto:a@b.c");
  });
});

describe("foldIcsLine", () => {
  it("leaves a line of 75 octets whole", () => {
    const line = "S".repeat(75);
    expect(foldIcsLine(line)).toEqual([line]);
  });

  it("folds a line of 76 octets, the continuation starting with a space", () => {
    const parts = foldIcsLine("S".repeat(76));
    expect(parts).toEqual(["S".repeat(75), " S"]);
  });

  it("keeps every physical line within 75 octets, continuation space included", () => {
    const parts = foldIcsLine("D".repeat(500));
    for (const p of parts) expect(octets(p)).toBeLessThanOrEqual(75);
    expect(parts.slice(1).every((p) => p.startsWith(" "))).toBe(true);
    expect(unfold(parts.join("\r\n"))).toBe("D".repeat(500));
  });

  it("counts octets, not characters: 40 three-byte characters are 120 octets", () => {
    const line = "活".repeat(40);
    const parts = foldIcsLine(line);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(octets(p)).toBeLessThanOrEqual(75);
  });

  it("never splits a multibyte character", () => {
    // Two-byte, three-byte and four-byte characters, in a long mixed line.
    const line = "é活😀".repeat(60);
    const parts = foldIcsLine(line);
    for (const p of parts) {
      expect(octets(p)).toBeLessThanOrEqual(75);
      // A split character would decode to U+FFFD.
      expect(p).not.toContain("�");
    }
    expect(unfold(parts.join("\r\n"))).toBe(line);
  });

  it("moves a four-byte character whole to the next line when only 3 octets are left", () => {
    // 72 octets of ASCII, then an emoji (4 octets): 76 would not fit.
    const parts = foldIcsLine("a".repeat(72) + "😀");
    expect(parts).toEqual(["a".repeat(72), " 😀"]);
  });

  it("handles the empty line", () => {
    expect(foldIcsLine("")).toEqual([""]);
  });
});

describe("icsUid", () => {
  it("is the same every time for the same thing", () => {
    expect(icsUid("event", 12)).toBe(icsUid("event", 12));
    expect(icsUid("event", 12)).toBe("event-12@calendar.rhapp");
  });

  it("differs by kind and by id", () => {
    expect(icsUid("event", 12)).not.toBe(icsUid("proposal", "12"));
    expect(icsUid("event", 12)).not.toBe(icsUid("event", 13));
  });

  it("keeps only safe characters from an id", () => {
    expect(icsUid("proposal", "66a;b,c\r\nD")).toBe(
      "proposal-66abcD@calendar.rhapp",
    );
  });
});

describe("icsUtc", () => {
  it("writes UTC with a Z", () => {
    expect(icsUtc(Date.UTC(2026, 10, 1, 0, 5, 9) / 1000)).toBe(
      "20261101T000509Z",
    );
  });
});

describe("writeIcs", () => {
  it("uses CRLF on every line and ends with one", () => {
    const out = writeIcs({ name: "RHApp", entries: [entry()] });
    expect(out.endsWith("\r\n")).toBe(true);
    // No bare LF anywhere.
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("is a calendar with a version, a product id and the zone it is in", () => {
    const out = writeIcs({ name: "RHApp", entries: [] });
    const lines = out.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("X-WR-TIMEZONE:Asia/Singapore");
    expect(lines[lines.length - 2]).toBe("END:VCALENDAR");
  });

  it("writes times in UTC and a stable UID for an entry", () => {
    const text = writeIcs({ name: "RHApp", entries: [entry()] });
    expect(text).toContain("UID:event-12@calendar.rhapp\r\n");
    expect(text).toContain("DTSTART:20261101T000000Z\r\n");
    expect(text).toContain("DTEND:20261101T020000Z\r\n");
    expect(text).toContain("DTSTAMP:20261001T000000Z\r\n");
    expect(writeIcs({ name: "RHApp", entries: [entry()] })).toBe(text);
  });

  it("leaves DTEND out when there is no end, or the end is not after the start", () => {
    const start = entry().start;
    for (const end of [null, undefined, start, start - 60]) {
      expect(writeIcs({ name: "x", entries: [entry({ end })] })).not.toContain(
        "DTEND",
      );
    }
  });

  it("escapes commas, semicolons, newlines and backslashes in every text property", () => {
    const text = writeIcs({
      name: "A, B",
      entries: [
        entry({
          summary: "Talk; Q&A, part 1",
          description: "Line one\nLine two \\ end",
          location: "Hall, Level 2; Room B",
        }),
      ],
    });
    const flat = unfold(text);
    expect(flat).toContain("X-WR-CALNAME:A\\, B\r\n");
    expect(flat).toContain("SUMMARY:Talk\\; Q&A\\, part 1\r\n");
    expect(flat).toContain("DESCRIPTION:Line one\\nLine two \\\\ end\r\n");
    expect(flat).toContain("LOCATION:Hall\\, Level 2\\; Room B\r\n");
  });

  it("folds long multibyte text at 75 octets and unfolds back to the original", () => {
    const title = "迎新晚会 ".repeat(30) + "Welcome, 😀 night";
    const text = writeIcs({
      name: "RHApp",
      entries: [entry({ summary: title })],
    });
    for (const physical of text.split("\r\n")) {
      expect(octets(physical)).toBeLessThanOrEqual(75);
    }
    expect(unfold(text)).toContain(`SUMMARY:${escapeIcsText(title)}\r\n`);
  });

  it("marks a proposal tentative and an event confirmed", () => {
    const text = writeIcs({
      name: "x",
      entries: [
        entry(),
        entry({
          uid: icsUid("proposal", "abc"),
          status: "TENTATIVE",
          categories: "Proposal",
        }),
      ],
    });
    expect(text).toContain("STATUS:CONFIRMED");
    expect(text).toContain("STATUS:TENTATIVE");
    expect(text).toContain("CATEGORIES:Proposal");
  });
});
