import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";

import { env } from "~/env";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = (req: NextRequest) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError:
      env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(
              `❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
            );
          }
        : undefined,
  });

/**
 * Vercel kills a serverless function at its maxDuration and the client sees a
 * failed request with no body — so a partially-completed loop looks, from the
 * outside, exactly like a network error.
 *
 * That is not hypothetical here. `commitBulkChunk` writes bulk role grants row
 * by row, and the chunk size in `_lib/planClient.ts` was sized against an
 * ESTIMATE of ~300ms per row. Measured against production it is ~2s per row
 * (five Atlas round-trips: role read, guard read, the transaction, the audit
 * write, the flag write — each far slower than the 60ms assumed). An 11-row
 * import died after 7 rows at the DEFAULT ceiling, twice, deterministically:
 * the 7 landed, the last 4 vanished, and the BulkRoleImport row was left with
 * finishedAt: null because the code that sets it never ran.
 *
 * 60s is the ceiling this route was always documented to need — planClient.ts
 * says so and notes the file "was out of scope for this change", which is how
 * the gap survived. The chunk size is ALSO cut to match the measured cost;
 * both were wrong and fixing either alone still truncates a large import.
 */
export const maxDuration = 60;

export { handler as GET, handler as POST };
