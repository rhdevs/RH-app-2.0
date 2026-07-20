"use client";

import Link from "next/link";
import Image from "next/image";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import RosterDriftNote from "~/app/_components/RosterDriftNote";
import StatTile from "./StatTile";
import CcaHandoverDialog from "./CcaHandoverDialog";

/**
 * The dashboard landing section: how many heads, how many members, who the
 * other heads are, and the CCA's own details.
 *
 * COUNTS COME FROM THE ROSTER RESOLVER, not a cheaper userCCA.count().
 *
 * A raw count would count ROWS, and duplicate membership rows are real in this
 * data — the same person can hold a legacy A-format row and a canonical one.
 * The member list dedupes by User.id, so a row count would say 34 here while
 * the list below it shows 32. A number that disagrees with the list it
 * summarises is worse than a slower query: it reads as a bug in whichever of
 * the two the reader trusts less. One resolver, one truth.
 */
export default function CcaOverview({ ccaID }: { ccaID: number }) {
  const roster = api.cca.getRoster.useQuery({ ccaID }, { retry: false });
  const mine = api.cca.listMine.useQuery(undefined, { retry: false });
  const profile = api.cca.getProfile.useQuery({ ccaID }, { retry: false });
  const [handoverOpen, setHandoverOpen] = useState(false);

  if (roster.error) {
    if (roster.error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm font-medium text-gray-900">
            You don&rsquo;t have access to this CCA
          </p>
          <p className="mt-1 text-sm text-gray-500">
            You can only view CCAs you&rsquo;re listed as a head of. If that
            should include this one, contact the JCRC.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6">
        <p className="text-sm font-medium text-red-900">
          This CCA couldn&rsquo;t be loaded
        </p>
        <p className="mt-1 text-sm text-red-700">
          Reload the page. If it keeps happening, contact the JCRC.
        </p>
      </div>
    );
  }

  const loading = roster.isPending;
  const data = roster.data;
  const membership = mine.data?.ccas.find((c) => c.ccaID === ccaID) ?? null;

  const p = profile.data;

  return (
    <div className="space-y-6">
      {/* Banner. `unoptimized` because these are already downscaled to
          1600×400 WebP on upload — running them back through the image
          optimizer would spend transformations to save almost nothing. */}
      {p?.bannerUrl && (
        <div className="relative h-36 w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-50 sm:h-48">
          <Image
            src={p.bannerUrl}
            alt=""
            fill
            className="object-cover"
            sizes="100vw"
            unoptimized
            priority
          />
        </div>
      )}

      {(p?.logoUrl ?? p?.description) && (
        <section className="flex items-start gap-4 rounded-lg border border-gray-200 bg-white p-5">
          {p?.logoUrl && (
            <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-gray-200 bg-gray-50">
              <Image
                src={p.logoUrl}
                alt=""
                fill
                className="object-contain"
                sizes="64px"
                unoptimized
              />
            </div>
          )}
          {p?.description ? (
            // whitespace-pre-wrap preserves the line breaks a head typed.
            // React escapes the content, which is what makes rendering
            // user-authored prose safe without a sanitizer.
            <p className="min-w-0 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
              {p.description}
            </p>
          ) : (
            <p className="text-sm italic text-gray-400">
              No description yet.
            </p>
          )}
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Heads"
          value={data?.counts.heads ?? 0}
          loading={loading}
          hint="Including you"
        />
        <StatTile
          label="Members"
          value={data?.counts.members ?? 0}
          loading={loading}
          hint="People, not records"
        />
      </div>

      {data && <RosterDriftNote drift={data.drift} />}

      {/* Co-heads. Already resolved by the roster query — no extra call. */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Heads
          </h2>
          {data && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHandoverOpen(true)}
            >
              Hand over
            </Button>
          )}
        </div>
        {loading ? (
          <div className="h-20 animate-pulse rounded-lg bg-gray-200" />
        ) : data && data.heads.length > 0 ? (
          <ul className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
            {data.heads.map((h) => (
              <li
                key={h.kind === "resolved" ? h.userId : h.key}
                className={`px-4 py-3 ${
                  h.kind === "unresolved" ? "bg-amber-50" : ""
                }`}
              >
                {h.kind === "resolved" ? (
                  <>
                    <p className="text-sm font-medium text-gray-900">
                      {h.displayName ?? h.email}
                    </p>
                    <p className="text-xs text-gray-500">{h.email}</p>
                  </>
                ) : (
                  <p
                    className="text-sm text-amber-900"
                    title="This head record doesn't match any account we can find."
                  >
                    Unmatched head record ({h.key})
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-gray-200 bg-white px-4 py-4 text-sm text-gray-500">
            Nobody is currently listed as a head of this CCA.
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Details
        </h2>
        <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 sm:grid-cols-3">
          {[
            { k: "Category", v: data?.cca.category ?? "Uncategorised" },
            { k: "CCA id", v: String(ccaID) },
            {
              k: "You became head",
              v: membership?.grantedAt
                ? new Date(membership.grantedAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })
                : "—",
            },
          ].map((row) => (
            <div key={row.k} className="bg-white px-4 py-3">
              <dt className="text-xs text-gray-500">{row.k}</dt>
              <dd className="mt-0.5 text-sm text-gray-900">{row.v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-gray-400">
          Name and category are set by the JCRC. You can edit your CCA&rsquo;s{" "}
          <Link
            href={`/cca/${ccaID}/details`}
            className="font-medium text-emerald-700 underline underline-offset-2"
          >
            description
          </Link>
          .
        </p>
      </section>

      {data && (
        <CcaHandoverDialog
          ccaID={ccaID}
          currentHeads={data.heads}
          open={handoverOpen}
          onOpenChange={setHandoverOpen}
        />
      )}
    </div>
  );
}
