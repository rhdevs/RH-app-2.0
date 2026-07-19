"use client";

import { useState } from "react";
import { useSession } from "next-auth/react";

import { api } from "~/trpc/react";
import {
  BASELINE_ROLE,
  GRANTABLE_ROLES,
  isGrantableRole,
} from "~/server/api/services/roles";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";

import { useCapabilities } from "../AdminCapabilityContext";
import RoleBadge, { MissingBaselineIcon } from "../RoleBadge";
import { isMissingBaseline } from "../../_lib/anomalies";
import type { AdminUserRow } from "../../_lib/types";

const ROLE_LABEL: Record<string, string> = {
  admin: "Admin",
  jcrc: "JCRC",
  cca_head: "CCA Head",
};

/**
 * Copy for a role the viewer may not change. Naming WHO can change it is worth
 * more than a generic "not permitted" — the operator's next action is to ask
 * that person.
 */
const LOCKED_REASON: Record<string, string> = {
  admin: "Only admins can grant or revoke the admin role",
  // D-3, reversing v1: this now covers the GRANT direction too. v1's copy
  // covered removal only.
  jcrc: "Only an admin can grant or remove the JCRC role.",
  // I-14: cca_head is in GRANTABLE_ROLES (the CCA endpoints must be able to
  // write it) but in nobody's ASSIGNABLE_BY, so it is unreachable from here for
  // everyone including admins. The server answers USE_CCA_HEAD_ENDPOINT.
  cca_head:
    "CCA headship is managed from the CCAs surface, so the scoped record stays in sync.",
};

export default function ManageRolesDialog({
  target,
  onClose,
}: {
  target: AdminUserRow;
  onClose: () => void;
}) {
  const cap = useCapabilities();
  const { data: session } = useSession();
  const utils = api.useUtils();

  // C9 surfaced this WITHOUT an error, which is why it is called out: both
  // sides are now `CanonicalUserID | null`, so two absent identities compare
  // EQUAL and an operator with no canonical id would be told every identity-less
  // target is themselves — firing the self-demotion interstitial on a stranger.
  // Identical latent bug pre-C9 (`"" === ""`), invisible because both were
  // `string`. `Boolean(...) &&` is the same shape access.ts:241 uses.
  const isSelf =
    Boolean(target.canonicalUserID) &&
    target.canonicalUserID === session?.user?.userID;
  const storedGrantable = target.roles.filter(isGrantableRole);
  const holdsBaseline = target.roles.includes(BASELINE_ROLE);
  const anomaly = isMissingBaseline(target);

  const [selected, setSelected] = useState<string[]>(storedGrantable);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | { title: string; body: string }>(
    null,
  );

  const editable = (role: string) =>
    cap.assignableRoles.includes(role as never) ||
    cap.revocableRoles.includes(role as never);

  const setRoles = api.admin.setUserRoles.useMutation({
    onSuccess: async () => {
      await utils.admin.listUsers.invalidate();
      onClose();
    },
    // Inline, and the dialog STAYS OPEN: the operator's selections are the
    // input to their next attempt. The last-admin and conflict guards are
    // transactional and can only be reported from here.
    onError: (e) => setFormError(e.message),
  });

  const submit = () => {
    setFormError(null);
    // C9. The compiler refused `userID: target.canonicalUserID` here, and it was
    // right to: this dialog submits the GRANT TARGET, and an absent identity
    // submitted as one is 09's whole class — a write keyed to nothing. The
    // table already disables Manage for such a row (UserRoleTable :235), so
    // this is unreachable through the UI and no operator's experience changes;
    // but that guard is a render decision, and the write deserves its own.
    // Server-side `userIDSchema.min(1)` was and remains the real backstop.
    const targetUserID = target.canonicalUserID;
    if (targetUserID === null) {
      setFormError(
        "This account has no canonical NUSNET id, so roles cannot be keyed to it.",
      );
      return;
    }
    setRoles.mutate({
      // canonicalUserID, NEVER legacyUserID — the latter holds an A-format
      // matric for ~515 rows and a grant keyed on it creates a row no session
      // will ever match (I-1).
      userID: targetUserID,
      roles: selected as ("admin" | "jcrc" | "cca_head")[],
      reason: reason.trim() || undefined,
    });
  };

  /**
   * Two changes warrant an interstitial. Neither is a security control — the
   * server decides — but both are irreversible-feeling and one is genuinely
   * unrecoverable by the actor.
   */
  const attemptSubmit = () => {
    const removed = storedGrantable.filter((r) => !selected.includes(r));
    if (isSelf && removed.includes("admin")) {
      setConfirm({
        title: "Remove your own admin role?",
        body: "You will lose access to this dashboard immediately. Only another admin can restore it.",
      });
      return;
    }
    if (isSelf && removed.includes("jcrc")) {
      // A D-3 consequence v1 did not surface: ASSIGNABLE_BY.jcrc is [], so no
      // peer can put this back.
      setConfirm({
        title: "Step down from JCRC?",
        body: "No other JCRC member can restore this. Only an administrator can.",
      });
      return;
    }
    submit();
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage roles</DialogTitle>
            <DialogDescription>
              {target.displayName ?? target.email ?? target.canonicalUserID} ·{" "}
              <span className="font-mono text-xs">
                {target.canonicalUserID}
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* D-1 / I-8e: `resident` is a READ-ONLY BADGE, never a Switch. It
                is not in the payload, AND the server's write cannot express its
                removal (`removed ⊆ GRANTABLE_ROLES`, which excludes it). Either
                alone would be insufficient — the UI is cosmetic (I-7), so the
                omission here is copy consistency and the chokepoint in
                applyRoleChange is the mechanism. */}
            <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-gray-900">Resident</p>
                <p className="text-xs text-gray-500">
                  Automatic for every verified NUS account. Cannot be granted or
                  removed here.
                </p>
              </div>
              {holdsBaseline ? (
                <RoleBadge role={BASELINE_ROLE} />
              ) : anomaly ? (
                // Eligible but missing the stored baseline: show the anomaly,
                // do NOT offer a control to add it. Repair is ensureBaseline's
                // job at their next sign-in (I-8b), not an operator's.
                <MissingBaselineIcon />
              ) : (
                <span className="text-xs text-gray-400">Not applicable</span>
              )}
            </div>

            {GRANTABLE_ROLES.map((role) => {
              const can = editable(role);
              const on = selected.includes(role);
              return (
                <div
                  key={role}
                  className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 px-3 py-2.5"
                  title={can ? undefined : LOCKED_REASON[role]}
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">
                      {ROLE_LABEL[role] ?? role}
                    </p>
                    {!can && (
                      <p className="text-xs text-gray-500">
                        {LOCKED_REASON[role]}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={on}
                    disabled={!can || setRoles.isPending}
                    onCheckedChange={(v) =>
                      setSelected((prev) =>
                        v ? [...prev, role] : prev.filter((r) => r !== role),
                      )
                    }
                  />
                </div>
              );
            })}

            <div>
              <label
                htmlFor="role-reason"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                Reason <span className="text-gray-400">(optional)</span>
              </label>
              {/* Optional deliberately: forcing a reason on every toggle makes
                  people type "x". Stored on the audit row when supplied. */}
              <Textarea
                id="role-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Recorded on the audit entry."
                rows={2}
              />
            </div>

            {formError && (
              <Alert variant="destructive">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-700 text-white hover:bg-emerald-800"
              disabled={setRoles.isPending}
              onClick={attemptSubmit}
            >
              {setRoles.isPending ? "Saving…" : "Save roles"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirm && (
        <AlertDialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirm.title}</AlertDialogTitle>
              <AlertDialogDescription>{confirm.body}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(null);
                  submit();
                }}
              >
                Continue
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
