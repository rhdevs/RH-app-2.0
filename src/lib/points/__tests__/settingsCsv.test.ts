import { describe, expect, it } from "vitest";

import {
  buildSettingsCsv,
  settingsCsvFilename,
  type SettingsWaiver,
} from "~/lib/points/settingsCsv";

const AT = new Date("2027-04-01T09:30:00.000Z");
const DEFAULT = { meanMin: 10, meanMax: 14, sdMin: 2, sdMax: 5 };

const waiver = (patch: Partial<SettingsWaiver> = {}): SettingsWaiver => ({
  ccaID: 9101,
  ccaName: "Hall Choir, Senior",
  meanMin: 12,
  meanMax: 15,
  sdMin: 1.5,
  sdMax: 5,
  note: "Small CCA (<10 members)",
  ...patch,
});

const lines = (csv: string): string[] => csv.split("\r\n");

describe("buildSettingsCsv", () => {
  it("writes the exact bytes the sandbox reads", () => {
    expect(
      buildSettingsCsv({
        defaultRange: DEFAULT,
        waivers: [waiver()],
        exportedAt: AT,
      }),
    ).toBe(
      "formatVersion,scope,ccaID,ccaName,meanMin,meanMax,sdMin,sdMax,note,exportedAt\r\n" +
        "1,default,,,10,14,2,5,,2027-04-01T09:30:00.000Z\r\n" +
        '1,waiver,9101,"Hall Choir, Senior",12,15,1.5,5,Small CCA (<10 members),2027-04-01T09:30:00.000Z\r\n',
    );
  });

  it("fills a waiver's blank fields from the default", () => {
    const csv = buildSettingsCsv({
      defaultRange: DEFAULT,
      waivers: [
        waiver({
          meanMin: null,
          meanMax: 16,
          sdMin: null,
          sdMax: null,
          ccaName: "Dance",
          note: "n",
        }),
      ],
      exportedAt: AT,
    });
    expect(lines(csv)[2]).toBe(
      "1,waiver,9101,Dance,10,16,2,5,n,2027-04-01T09:30:00.000Z",
    );
  });

  it("sorts waivers by ccaID ascending", () => {
    const csv = buildSettingsCsv({
      defaultRange: DEFAULT,
      waivers: [
        waiver({ ccaID: 9300 }),
        waiver({ ccaID: 9101 }),
        waiver({ ccaID: 9200 }),
      ],
      exportedAt: AT,
    });
    expect(
      lines(csv)
        .slice(2, 5)
        .map((l) => l.split(",")[2]),
    ).toEqual(["9101", "9200", "9300"]);
  });

  it("writes only the default row when there are no waivers", () => {
    const csv = buildSettingsCsv({
      defaultRange: DEFAULT,
      waivers: [],
      exportedAt: AT,
    });
    expect(lines(csv)).toEqual([
      "formatVersion,scope,ccaID,ccaName,meanMin,meanMax,sdMin,sdMax,note,exportedAt",
      "1,default,,,10,14,2,5,,2027-04-01T09:30:00.000Z",
      "",
    ]);
  });

  it.each(["=", "+", "-", "@", "\t", "\r"])(
    "guards a CCA name and note starting with %j",
    (lead) => {
      const csv = buildSettingsCsv({
        defaultRange: DEFAULT,
        waivers: [waiver({ ccaName: `${lead}x`, note: `${lead}y` })],
        exportedAt: AT,
      });
      const row = csv.split("\r\n").slice(2).join("\r\n");
      if (lead === "\r") {
        expect(row).toContain(`"'\rx"`);
        expect(row).toContain(`"'\ry"`);
      } else {
        expect(row).toContain(`'${lead}x`);
        expect(row).toContain(`'${lead}y`);
      }
    },
  );

  it("does not mutate its inputs", () => {
    const waivers = Object.freeze([
      Object.freeze(waiver({ ccaID: 2 })),
      Object.freeze(waiver({ ccaID: 1 })),
    ]);
    expect(() =>
      buildSettingsCsv({ defaultRange: DEFAULT, waivers, exportedAt: AT }),
    ).not.toThrow();
    expect(waivers.map((w) => w.ccaID)).toEqual([2, 1]);
  });
});

describe("settingsCsvFilename", () => {
  it("is points_settings_<YYYYMMDD>.csv in local time", () => {
    expect(settingsCsvFilename(new Date(2027, 3, 1, 23, 59))).toBe(
      "points_settings_20270401.csv",
    );
    expect(settingsCsvFilename(new Date(2027, 11, 9, 0, 1))).toBe(
      "points_settings_20271209.csv",
    );
  });
});
