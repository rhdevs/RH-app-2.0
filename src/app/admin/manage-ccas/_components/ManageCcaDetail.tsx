"use client";

import { useState } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import RosterDriftNote from "~/app/_components/RosterDriftNote";

/**
 * Everything you can do to one CCA: rename it, manage its heads, add and remove
 * members.
 *
 * NO DELETE. See the note at the top of the page component.
 *
 * Head management calls admin.grantCcaHead / revokeCcaHead / transferCcaHead —
 * the procedures that already exist and already maintain invariant CH-1 in one
 * transaction. This panel is a UI over them and adds no new writer of the
 * `cca_head` string, which I-14 forbids.
 */

function friendlyError(message: string | undefined): string | null {
  if (!message) return null;
  const map: Record<string, string> = {
    CCA_MANAGEMENT_DISABLED: "CCA management is turned off.",
    ALREADY_A_MEMBER: "They're already a member of this CCA.",
    NO_SUCH_CCA: "That CCA no longer exists. Reload the page.",
    NO_SUCH_USER: "That account no longer exists. Reload the page.",
    SAME_USER: "Pick two different people.",
    NOT_A_HEAD_OF_THIS_CCA: "They aren't a head of this CCA.",
    CANNOT_MODIFY_AN_ADMIN: "You can't change an admin's roles.",
  };
  if (map[message]) return map[message]!;
  if (message.startsWith("CAPABILITY_REQUIRED"))
    return "You don't have permission to do that.";
  if (message.includes("canonical"))
    return "That doesn't look like an NUS email or NUSNET ID.";
  return "That didn't save. Try again.";
}

/* -- heads ----------------------------------------------------------------- */

function HeadsPanel({ ccaID, enabled }: { ccaID: number; enabled: boolean }) {
  const [newHead, setNewHead] = useState("");
  const utils = api.useUtils();

  const heads = api.admin.listCcaHeads.useQuery({ ccaID }, { retry: false });

  const refresh = async () => {
    await Promise.all([
      utils.admin.listCcaHeads.invalidate({ ccaID }),
      utils.cca.getRoster.invalidate({ ccaID }),
      utils.ccaAdmin.listAll.invalidate(),
    ]);
  };

  const grant = api.admin.grantCcaHead.useMutation({
    onSuccess: async () => {
      setNewHead("");
      await refresh();
    },
  });
  const revoke = api.admin.revokeCcaHead.useMutation({ onSuccess: refresh });

  const rows = heads.data ?? [];
  const error = friendlyError(grant.error?.message ?? revoke.error?.message);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Heads
        <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
          {rows.length}
        </span>
      </h3>

      {/* Soft warning, never a block. A hard cap is a guess about org structure
          that will be wrong for some CCA, and unrecoverable in-app. */}
      {rows.length > 3 && (
        <p className="text-xs text-amber-700">
          This CCA has {rows.length} heads. That&rsquo;s allowed, but worth a
          double-check.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Nobody heads this CCA, so nobody can see its roster from their own CCA
          page. Add a head below.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((h) => (
            <li
              key={h.userID}
              className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2"
            >
              <span className="font-mono text-sm text-gray-900">
                {h.userID}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={!enabled || revoke.isPending}
                onClick={() =>
                  revoke.mutate({ ccaID, userID: h.userID })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          grant.mutate({ ccaID, userID: newHead.trim().toUpperCase() });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`head-${ccaID}`}>Add a head</Label>
          <Input
            id={`head-${ccaID}`}
            value={newHead}
            onChange={(e) => setNewHead(e.target.value)}
            placeholder="E0425010"
            className="sm:w-64"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={!enabled || grant.isPending || !newHead.trim()}
        >
          {grant.isPending ? "Adding…" : "Add head"}
        </Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

/* -- members --------------------------------------------------------------- */

function MembersPanel({ ccaID, enabled }: { ccaID: number; enabled: boolean }) {
  const [newMember, setNewMember] = useState("");
  const utils = api.useUtils();

  // The SAME roster procedure /cca and /admin/ccas use. An admin passes its
  // object-scope guard on the manageCcaHeads capability.
  const roster = api.cca.getRoster.useQuery({ ccaID }, { retry: false });

  const refresh = async () => {
    await Promise.all([
      utils.cca.getRoster.invalidate({ ccaID }),
      utils.ccaAdmin.listAll.invalidate(),
    ]);
  };

  const add = api.ccaAdmin.addMember.useMutation({
    onSuccess: async () => {
      setNewMember("");
      await refresh();
    },
  });
  const remove = api.ccaAdmin.removeMember.useMutation({ onSuccess: refresh });

  const error = friendlyError(add.error?.message ?? remove.error?.message);
  const members = roster.data?.members ?? [];

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Members
        <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
          {members.length}
        </span>
      </h3>

      {roster.data && <RosterDriftNote drift={roster.data.drift} />}

      {roster.isPending ? (
        <div className="h-24 animate-pulse rounded-lg bg-gray-200" />
      ) : members.length === 0 ? (
        <p className="rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm text-gray-500">
          No members listed yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {members.map((m) => {
            const unmatched = m.kind === "unresolved";
            return (
              <li
                key={m.kind === "resolved" ? m.userId : m.key}
                className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                  unmatched
                    ? "border-amber-300 bg-amber-50"
                    : "border-gray-200 bg-white"
                }`}
              >
                <span className="min-w-0">
                  <span
                    className={`block truncate text-sm ${
                      unmatched ? "text-amber-900" : "text-gray-900"
                    }`}
                  >
                    {m.kind === "resolved"
                      ? (m.displayName ?? m.email)
                      : `Unmatched record (${m.key})`}
                  </span>
                  {m.kind === "resolved" && (
                    <span className="block truncate text-xs text-gray-500">
                      {m.email}
                    </span>
                  )}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!enabled || remove.isPending}
                  onClick={() =>
                    remove.mutate({
                      ccaID,
                      // Server-derived keys: we name a User document (or a raw
                      // unresolved key) and the procedure recomputes every
                      // membership key itself. Never client-supplied keys.
                      target:
                        m.kind === "resolved"
                          ? { kind: "user", userObjectId: m.userId }
                          : { kind: "key", key: m.key },
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate({ ccaID, userID: newMember.trim().toUpperCase() });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor={`member-${ccaID}`}>Add a member</Label>
          <Input
            id={`member-${ccaID}`}
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
            placeholder="E0425010"
            className="sm:w-64"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          disabled={!enabled || add.isPending || !newMember.trim()}
        >
          {add.isPending ? "Adding…" : "Add member"}
        </Button>
      </form>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

/* -- the record ------------------------------------------------------------ */

function RenamePanel({
  ccaID,
  enabled,
  initialName,
  initialCategory,
}: {
  ccaID: number;
  enabled: boolean;
  initialName: string;
  initialCategory: string;
}) {
  const [ccaName, setCcaName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory);
  const utils = api.useUtils();

  const rename = api.ccaAdmin.rename.useMutation({
    onSuccess: async () => {
      await utils.ccaAdmin.listAll.invalidate();
    },
  });

  const dirty = ccaName !== initialName || category !== initialCategory;
  const error = friendlyError(rename.error?.message);

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Details
      </h3>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate({
            ccaID,
            ccaName: ccaName.trim(),
            category: category.trim(),
          });
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`name-${ccaID}`}>Name</Label>
            <Input
              id={`name-${ccaID}`}
              value={ccaName}
              onChange={(e) => setCcaName(e.target.value)}
              maxLength={120}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`cat-${ccaID}`}>Category</Label>
            <Input
              id={`cat-${ccaID}`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={120}
              required
            />
          </div>
        </div>
        <p className="text-xs text-gray-400">
          Renaming keeps the CCA&rsquo;s id, so its members, heads and bookings
          stay attached.
        </p>
        <Button
          type="submit"
          variant="outline"
          disabled={!enabled || rename.isPending || !dirty}
        >
          {rename.isPending ? "Saving…" : "Save changes"}
        </Button>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {rename.isSuccess && !dirty && (
          <p className="text-sm text-emerald-700">Saved.</p>
        )}
      </form>
    </section>
  );
}

/* -- shell ----------------------------------------------------------------- */

export default function ManageCcaDetail({
  ccaID,
  enabled,
  cca,
}: {
  ccaID: number;
  enabled: boolean;
  cca: { ccaName: string; category: string };
}) {
  return (
    <div className="space-y-8 rounded-lg border border-gray-200 bg-gray-50 p-5">
      <header>
        <h2 className="text-lg font-semibold text-gray-900">{cca.ccaName}</h2>
        <p className="text-sm text-gray-500">
          {cca.category} · id {ccaID}
        </p>
      </header>

      <RenamePanel
        ccaID={ccaID}
        enabled={enabled}
        initialName={cca.ccaName}
        initialCategory={cca.category}
      />
      <HeadsPanel ccaID={ccaID} enabled={enabled} />
      <MembersPanel ccaID={ccaID} enabled={enabled} />
    </div>
  );
}
