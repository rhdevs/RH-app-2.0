// EditProfileModal.tsx
"use client";

import React, { useState } from "react";
import { api } from "~/trpc/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  BIO_MAX,
  BLOCKS,
  DISPLAY_NAME_MAX,
  MATRIC_RE,
  updateProfileInput,
} from "~/lib/schemas/profile";
import {
  isDisplayNameValid,
  PROFILE_FIELD_LABEL,
  type ProfileField,
} from "~/lib/profileCompleteness";

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialData: {
    displayName: string;
    telegramHandle: string;
    bio: string;
    /** "" means the user has never chosen a block. Deliberately NOT defaulted to
     *  a real block: pre-selecting one lets a user save a block they never
     *  picked. */
    block: number | "";
    /** "" when no matric has been set yet. */
    matric: string;
  };
  /** Given the message to surface, so the toast reflects what ACTUALLY saved
   *  rather than a fixed "Profile updated" that lies on a partial save. */
  onSuccess: (message: string) => void;
  /**
   * FORCED (profile-completion) mode. When true the dialog cannot be dismissed
   * — no Close button, Escape and overlay-click are ignored — and the copy
   * switches to "complete your profile to continue". Used by the strict profile
   * gate on /profile.
   */
  forced?: boolean;
  /** In forced mode, the fields that must be filled/valid before Save. */
  requiredFields?: ProfileField[];
  /**
   * MINIMAL-PROFILE mode: this account is exempt from the strict profile gate's
   * block/telegram/matric requirements (see MINIMAL_PROFILE_ROLES in
   * src/lib/profileCompleteness.ts — hall-office staff, who have no hall block).
   *
   * IT EXISTS BECAUSE THE BLOCK CHECK IN handleSubmit WAS UNCONDITIONAL. That
   * check returns before any mutation fires, so without this prop an exempt
   * account could not save the form AT ALL — not even a display-name change —
   * and the only symptom would be an inline "Please select your block." on a
   * field they were told was not required. A hard blocker with a soft-looking
   * error message.
   *
   * Deliberately SEPARATE from `forced`: it describes WHO the account is, not
   * whether the dialog is dismissable, and the two combine in all four ways (an
   * exempt account still gets the non-dismissable dialog if its display name is
   * missing).
   */
  minimalProfile?: boolean;
  /** Called after a successful save INSTEAD of onClose when forced — the parent
   *  refreshes the session so the gate re-evaluates and unmounts this itself. */
  onSaved?: () => void | Promise<void>;
}

/** The stored form of a typed matric. Matches the server's own transform
 *  (trim + uppercase) so the "did it change?" comparison is not fooled by
 *  whitespace or case. */
const normalizeMatric = (v: string) => v.trim().toUpperCase();

/**
 * This modal renders NO role control of any kind — no checkbox, no select, and
 * no `roles` key in the mutation payload. That is what makes it structurally
 * impossible for a profile save to strip `resident` (lockout mode 16). Roles are
 * read-only badges on the profile page. Keep it that way; role mutation belongs
 * to the admin surface behind its escalation guards.
 *
 * It DOES take a `minimalProfile` flag, which is a different thing entirely: it
 * carries no privilege and grants nothing. It only relaxes the client-side
 * BLOCK requirement for accounts the profile gate already exempts server-side
 * (src/lib/profileCompleteness.ts). The server re-derives that exemption from
 * the live role set on every request; this flag is never trusted for anything.
 */
const EditProfileModal: React.FC<EditProfileModalProps> = ({
  isOpen,
  onClose,
  initialData,
  onSuccess,
  forced = false,
  requiredFields = [],
  minimalProfile = false,
  onSaved,
}) => {
  const requires = (f: ProfileField) => forced && requiredFields.includes(f);
  const [displayName, setDisplayName] = useState<string>(
    initialData.displayName,
  );
  const [telegramHandle, setTelegramHandle] = useState<string>(
    initialData.telegramHandle,
  );
  const [bio, setBio] = useState<string>(initialData.bio);
  const [block, setBlock] = useState<number | "">(initialData.block);
  const [matric, setMatric] = useState<string>(initialData.matric);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  const utils = api.useUtils();

  // Both mutations are driven imperatively from handleSubmit via mutateAsync
  // rather than through onSuccess/onError callbacks. Two independent writes
  // land here (profile fields via updateUserData, matric via setMatric —
  // `writeMatric` is the single matric writer, so it CANNOT be folded into
  // updateUserData), and per-mutation callbacks cannot express "one succeeded,
  // the other did not". Closing the modal and toasting success from the first
  // callback while the second is still in flight is exactly how a failed save
  // gets reported as a good one.
  const updateUser = api.user.updateUserData.useMutation();
  const setMatricMutation = api.user.setMatric.useMutation();

  const handleSubmit = async () => {
    setFormError(null);

    // A RESIDENT MUST STILL PICK A BLOCK, and this returns before any mutation
    // fires, so it is a hard stop rather than a warning. It was UNCONDITIONAL,
    // which made the form unsaveable for a profile-gate-exempt account (hall
    // office: no block to pick, and none required of them) — see the
    // `minimalProfile` prop. Gating it here rather than deleting it keeps every
    // resident's path byte-identical: their payload always carries a block, so
    // the server's `block` becoming optional never widens what they can send.
    if (!minimalProfile && block === "") {
      setFieldErrors({ block: "Please select your block." });
      return;
    }

    // OMITTED, NOT SENT AS "" OR null. `block` is optional on the shared schema
    // and `undefined` means "leave the stored value alone" — there is
    // deliberately no value meaning "clear it". Computed ONCE and spread into
    // BOTH the client-side mirror parse below and the mutation payload, so the
    // two cannot disagree about what is being submitted. Only reachable with
    // `block === ""` in minimal mode, because of the guard above.
    const blockPayload = block === "" ? {} : { block };

    // Mirror the server's validation client-side using the SAME schema, so the
    // two can never disagree about what is accepted.
    const parsed = updateProfileInput.safeParse({
      displayName,
      telegramHandle,
      bio,
      ...blockPayload,
    });

    const errs: Record<string, string> = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !errs[key]) errs[key] = issue.message;
      }
    }

    // Same regex the server refines on (MATRIC_RE from the shared schema) —
    // not a second validator.
    const nextMatric = normalizeMatric(matric);
    const matricChanged = nextMatric !== normalizeMatric(initialData.matric);
    if (matricChanged && !MATRIC_RE.test(nextMatric)) {
      errs.matric =
        nextMatric === ""
          ? "Enter your matriculation number."
          : "Enter it in the format A0234567X — a letter, seven digits and a letter.";
    }

    // Strict display-name rule (mirrors the server): not blank, and not an
    // E-format NUSNET id. A check on the SHAPE of what was typed, so it needs no
    // identity — see profileCompleteness.ts. Applied on a normal edit too, so it
    // surfaces as this friendly inline error rather than a raw server rejection.
    if (!isDisplayNameValid(displayName)) {
      errs.displayName ??= "Enter your real name — not your NUSNET ID.";
    }

    // Forced-mode presence requirements: these fields are optional on a normal
    // edit but mandatory when completing a profile.
    //
    // ALREADY ROLE-AWARE, with no change needed here: `requires(f)` is driven by
    // `requiredFields`, which the page passes straight from the session's
    // `profileMissingFields` — computed server-side by the role-aware
    // computeProfileGaps. An exempt account is never asked for these, so these
    // two checks simply do not fire for them. Do NOT add `minimalProfile` here;
    // that would be a second derivation of the same exemption, and the two would
    // drift.
    if (requires("telegramHandle") && telegramHandle.trim() === "") {
      errs.telegramHandle ??= "Enter your Telegram handle to continue.";
    }
    if (requires("matric") && nextMatric === "") {
      errs.matric ??= "Enter your matriculation number to continue.";
    }

    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      return;
    }

    setFieldErrors({});
    setIsSaving(true);

    // ORDER IS DELIBERATE: matric first. It is the write that can be REFUSED
    // outright (already registered to another account), and running it first
    // means that refusal leaves nothing at all saved — a clean "nothing
    // happened, fix this and retry" instead of a half-applied form.
    let matricSaved = false;
    try {
      if (matricChanged) {
        await setMatricMutation.mutateAsync({ matric: nextMatric });
        matricSaved = true;
        // No optimistic setData for matric. The cached profile is a UNION of an
        // ordinary profile and the empty-identity shape, and patching `matric`
        // across it does not typecheck — nor should it, since the two shapes
        // disagree about whether a matric can exist at all. The invalidate
        // below plus the page's own refetch supply the new value.
      }

      const updated = await updateUser.mutateAsync({
        displayName,
        telegramHandle,
        bio,
        // The SAME object the mirror parse above validated. See blockPayload.
        ...blockPayload,
      });

      // The MERGE matters: the mutation deliberately returns neither roles nor
      // matric nor eligible, so a naive setData(updated) would blank the badges
      // until the background invalidate resolves — i.e. it would flash the
      // "No roles — cannot book" warning at a user who is perfectly fine.
      // The mutation's select also omits userID and email, so this cannot
      // clobber the session-derived canonical id (I-1).
      utils.user.getCurrentUserData.setData(undefined, (old) =>
        old ? { ...old, ...updated } : old,
      );
      void utils.user.getCurrentUserData.invalidate();

      if (forced) {
        // The parent refreshes the session; the gate re-evaluates and unmounts
        // this dialog itself once the profile is complete. Do NOT onClose here —
        // a still-incomplete save (shouldn't happen, but safe) must keep it up.
        await onSaved?.();
      } else {
        onSuccess(
          matricSaved
            ? "Profile and matriculation number updated"
            : "Profile updated successfully",
        );
        onClose();
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Something went wrong.";
      // If matric went through and the profile write then failed, say so. The
      // alternative — a bare "could not save" — would send the user back to
      // re-enter a matric that is already stored.
      setFormError(
        matricSaved
          ? `Your matriculation number was saved, but the rest of your profile was not: ${message}`
          : message,
      );
      // A partial save means the cache no longer matches the database (the
      // matric landed, the profile fields did not), so refetch the truth.
      void utils.user.getCurrentUserData.invalidate();
    } finally {
      setIsSaving(false);
    }
  };

  const isPending = isSaving;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        // Radix gives us Escape, an overlay click, focus trapping, role="dialog"
        // and aria-modal for free. Do not hand-roll them again.
        if (forced) return; // FORCED: non-dismissable — no close path at all.
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent
        // Forced mode: block every dismissal route Radix offers and hide the
        // built-in close "X" (a direct-child absolute button) so there is no way
        // out but completing the form.
        onEscapeKeyDown={(e) => forced && e.preventDefault()}
        onPointerDownOutside={(e) => forced && e.preventDefault()}
        onInteractOutside={(e) => forced && e.preventDefault()}
        className={`max-h-[90vh] overflow-y-auto bg-white sm:max-w-lg${
          forced ? " [&>button.absolute]:hidden" : ""
        }`}
      >
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-gray-800">
            {forced ? "Complete your profile" : "Edit Profile"}
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">
            {forced
              ? "Fill in the details below to continue using the RHApp."
              : "Your email and roles cannot be changed here."}
          </DialogDescription>
        </DialogHeader>

        {forced && requiredFields.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Please add{" "}
            {requiredFields.map((f, i) => (
              <span key={f}>
                {i > 0 && (i === requiredFields.length - 1 ? " and " : ", ")}
                {PROFILE_FIELD_LABEL[f]}
              </span>
            ))}
            .
          </div>
        )}

        {formError && (
          <div
            role="alert"
            className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {formError}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label
              htmlFor="profile-display-name"
              className="block text-sm font-medium text-gray-700"
            >
              Display Name
            </label>
            <input
              id="profile-display-name"
              value={displayName}
              maxLength={DISPLAY_NAME_MAX}
              onChange={(e) => setDisplayName(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Shown to other residents on your bookings.
            </p>
            {fieldErrors.displayName && (
              <p className="mt-1 text-sm text-red-600">
                {fieldErrors.displayName}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="profile-telegram"
              className="block text-sm font-medium text-gray-700"
            >
              Telegram Handle
            </label>
            {/* "@" is a static prefix and any typed "@" is stripped on change,
                so there is exactly one canonical stored form. */}
            <div className="mt-1 flex items-center rounded-md border border-gray-300 shadow-sm focus-within:border-emerald-500 focus-within:ring-1 focus-within:ring-emerald-500">
              <span className="select-none pl-3 text-gray-500">@</span>
              <input
                id="profile-telegram"
                value={telegramHandle}
                onChange={(e) =>
                  setTelegramHandle(e.target.value.replace(/@/g, ""))
                }
                className="w-full rounded-md px-2 py-2 focus:outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-gray-500">
              5–32 characters: letters, digits or _.
              {requires("telegramHandle") ? "" : " Leave blank to remove it."}
            </p>
            {fieldErrors.telegramHandle && (
              <p className="mt-1 text-sm text-red-600">
                {fieldErrors.telegramHandle}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="profile-bio"
              className="block text-sm font-medium text-gray-700"
            >
              Bio
            </label>
            <textarea
              id="profile-bio"
              value={bio}
              maxLength={BIO_MAX}
              onChange={(e) => setBio(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              rows={3}
            />
            <p className="mt-1 text-right text-xs text-gray-500">
              {bio.length}/{BIO_MAX}
            </p>
            {fieldErrors.bio && (
              <p className="mt-1 text-sm text-red-600">{fieldErrors.bio}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="profile-block"
              className="block text-sm font-medium text-gray-700"
            >
              Block Number
            </label>
            <select
              id="profile-block"
              value={block === "" ? "" : String(block)}
              onChange={(e) =>
                setBlock(e.target.value === "" ? "" : Number(e.target.value))
              }
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="">Select Block</option>
              {BLOCKS.map((num) => (
                <option key={num} value={String(num)}>
                  {num}
                </option>
              ))}
            </select>
            {fieldErrors.block && (
              <p className="mt-1 text-sm text-red-600">{fieldErrors.block}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="profile-matric"
              className="block text-sm font-medium text-gray-700"
            >
              Matriculation Number
            </label>
            {/* Uppercased as you type so what is shown is what is stored — the
                server applies the same transform. */}
            <input
              id="profile-matric"
              value={matric}
              maxLength={9}
              autoComplete="off"
              spellCheck={false}
              placeholder="A0234567X"
              onChange={(e) => setMatric(e.target.value.toUpperCase())}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono uppercase shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              The number on your student card, like A0234567X. It is used to
              match you to hall records, so make sure it is exactly right.
            </p>
            {fieldErrors.matric && (
              <p className="mt-1 text-sm text-red-600">{fieldErrors.matric}</p>
            )}
          </div>
        </div>

        <DialogFooter className="mt-6 gap-2">
          {/* No Close in forced mode: the only way out is completing the form. */}
          {!forced && (
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Close
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSubmit()}
            // Save must be disabled while in flight, or rapid clicks fire N
            // concurrent updates.
            disabled={isPending}
            className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending
              ? "Saving…"
              : forced
                ? "Save and continue"
                : "Save Changes"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EditProfileModal;
