import { describe, expect, it, vi } from "vitest";

import {
  createCallerFactory,
  createTRPCRouter,
  mapUniqueViolation,
  publicProcedure,
  sanitizeErrors,
} from "~/server/api/trpc";

vi.mock("~/server/auth", () => ({ auth: vi.fn() }));
vi.mock("~/server/db", () => ({ db: {} }));

const failing = (error: unknown) =>
  createCallerFactory(
    createTRPCRouter({
      go: publicProcedure
        .use(sanitizeErrors)
        .use(mapUniqueViolation("the_index", "THE_MESSAGE"))
        .mutation(() => {
          throw error;
        }),
    }),
  )({ db: {}, session: null, headers: new Headers() } as never);

const unique = (over: Record<string, unknown> = {}) =>
  Object.assign(new Error("Unique constraint failed"), {
    code: "P2002",
    meta: { target: "the_index" },
    ...over,
  });

const run = async (error: unknown) => {
  try {
    await failing(error).go();
  } catch (e) {
    const t = e as { code: string; message: string };
    return `${t.code}:${t.message}`;
  }
  return "ok";
};

describe("mapUniqueViolation", () => {
  it("turns a violation of the named index into CONFLICT with the message", async () => {
    expect(await run(unique())).toBe("CONFLICT:THE_MESSAGE");
    expect(
      await run(
        unique({
          meta: undefined,
          message: "Unique constraint failed on the constraint: `the_index`",
        }),
      ),
    ).toBe("CONFLICT:THE_MESSAGE");
  });

  it("leaves a P2002 on another index generic", async () => {
    expect(await run(unique({ meta: { target: "other_index" } }))).toBe(
      "INTERNAL_SERVER_ERROR:Something went wrong.",
    );
    expect(await run(unique({ meta: undefined }))).toBe(
      "INTERNAL_SERVER_ERROR:Something went wrong.",
    );
  });

  it("leaves every other error alone", async () => {
    expect(await run(new Error("db down"))).toBe(
      "INTERNAL_SERVER_ERROR:Something went wrong.",
    );
    expect(
      await run(unique({ code: "P2025", meta: { target: "the_index" } })),
    ).toBe("INTERNAL_SERVER_ERROR:Something went wrong.");
  });
});
