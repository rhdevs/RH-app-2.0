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
  updateProfileInput,
} from "~/lib/schemas/profile";

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
  };
  onSuccess: () => void;
}

/**
 * This modal renders NO role control of any kind — no checkbox, no select, and
 * no `roles` key in the mutation payload. That is what makes it structurally
 * impossible for a profile save to strip `resident` (lockout mode 16). Roles are
 * read-only badges on the profile page. Keep it that way; role mutation belongs
 * to the admin surface behind its escalation guards.
 */
const EditProfileModal: React.FC<EditProfileModalProps> = ({
  isOpen,
  onClose,
  initialData,
  onSuccess,
}) => {
  const [displayName, setDisplayName] = useState<string>(
    initialData.displayName,
  );
  const [telegramHandle, setTelegramHandle] = useState<string>(
    initialData.telegramHandle,
  );
  const [bio, setBio] = useState<string>(initialData.bio);
  const [block, setBlock] = useState<number | "">(initialData.block);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const utils = api.useUtils();

  const updateUser = api.user.updateUserData.useMutation({
    onSuccess: (updated) => {
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
      onSuccess();
      onClose();
    },
    // Without this the modal just sits there on a rejection with no feedback,
    // which is how a validation change fails silently app-wide.
    onError: (e) => setFormError(e.message),
  });

  const handleSubmit = () => {
    setFormError(null);

    if (block === "") {
      setFieldErrors({ block: "Please select your block." });
      return;
    }

    // Mirror the server's validation client-side using the SAME schema, so the
    // two can never disagree about what is accepted.
    const parsed = updateProfileInput.safeParse({
      displayName,
      telegramHandle,
      bio,
      block,
    });

    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === "string" && !errs[key]) errs[key] = issue.message;
      }
      setFieldErrors(errs);
      return;
    }

    setFieldErrors({});
    updateUser.mutate({ displayName, telegramHandle, bio, block });
  };

  const isPending = updateUser.isPending;

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        // Radix gives us Escape, an overlay click, focus trapping, role="dialog"
        // and aria-modal for free. Do not hand-roll them again.
        if (!open && !isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-white sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold text-gray-800">
            Edit Profile
          </DialogTitle>
          <DialogDescription className="text-sm text-gray-500">
            Your email, matric number and roles cannot be changed here.
          </DialogDescription>
        </DialogHeader>

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
              5–32 characters: letters, digits or _. Leave blank to remove it.
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
        </div>

        <DialogFooter className="mt-6 gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            // Save must be disabled while in flight, or rapid clicks fire N
            // concurrent updates.
            disabled={isPending}
            className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save Changes"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default EditProfileModal;
