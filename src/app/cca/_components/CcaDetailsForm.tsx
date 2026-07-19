"use client";

import { useState, useEffect } from "react";

import { api } from "~/trpc/react";
import { Button } from "~/components/ui/button";
import { ccaProfileInput, CCA_DESCRIPTION_MAX } from "~/lib/schemas/cca";

/**
 * Edit the CCA's description — the only thing a head can currently change.
 *
 * useState + safeParse against the SHARED schema, per EditProfileModal. NOT
 * react-hook-form: it is in package.json but `~/components/ui/form.tsx` is
 * imported by nothing, so introducing it here would make this the only form in
 * the app using it.
 *
 * Name and category are deliberately NOT editable here. They live on the
 * $jsonSchema-guarded `CCA` collection and are renamed by admins through
 * ccaAdmin.rename; the description lives on CcaProfile precisely because it
 * cannot go there.
 */
export default function CcaDetailsForm({ ccaID }: { ccaID: number }) {
  const utils = api.useUtils();
  const profile = api.cca.getProfile.useQuery({ ccaID }, { retry: false });

  const [description, setDescription] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the textarea once the saved value arrives. Keyed on the query data
  // rather than done in render so typing is never clobbered by a refetch.
  useEffect(() => {
    if (profile.data) setDescription(profile.data.description);
  }, [profile.data]);

  const update = api.cca.updateProfile.useMutation({
    onSuccess: async () => {
      setSaved(true);
      await utils.cca.getProfile.invalidate({ ccaID });
    },
  });

  if (profile.isPending) {
    return <div className="h-56 animate-pulse rounded-lg bg-gray-200" />;
  }

  if (profile.error) {
    if (profile.error.message === "NOT_A_HEAD_OF_THIS_CCA") {
      return (
        <div className="rounded-lg border border-gray-200 bg-white px-4 py-6">
          <p className="text-sm font-medium text-gray-900">
            You don&rsquo;t have access to this CCA
          </p>
          <p className="mt-1 text-sm text-gray-500">
            You can only edit CCAs you&rsquo;re listed as a head of.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800">
        These details couldn&rsquo;t be loaded. Reload the page.
      </div>
    );
  }

  const serverError = update.error
    ? update.error.message === "NO_SUCH_CCA"
      ? "This CCA no longer exists. Reload the page."
      : update.error.message === "NOT_A_HEAD_OF_THIS_CCA"
        ? "You're no longer a head of this CCA."
        : "That didn't save. Try again."
    : null;

  const dirty = description !== (profile.data?.description ?? "");

  return (
    <form
      className="max-w-3xl space-y-4 rounded-lg border border-gray-200 bg-white p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        // Mirror the server's validation client-side using the SAME schema, so
        // the two can never disagree about what is accepted.
        const parsed = ccaProfileInput.safeParse({ ccaID, description });
        if (!parsed.success) {
          setFieldError(
            parsed.error.issues[0]?.message ?? "That description isn't valid.",
          );
          return;
        }
        setFieldError(null);
        update.mutate(parsed.data);
      }}
    >
      <div className="space-y-1.5">
        <label
          htmlFor="cca-description"
          className="block text-sm font-medium text-gray-700"
        >
          Description
        </label>
        <p className="text-xs text-gray-500">
          What your CCA does, who it&rsquo;s for, and anything a new member
          should know.
        </p>
        <textarea
          id="cca-description"
          value={description}
          maxLength={CCA_DESCRIPTION_MAX}
          rows={8}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          placeholder="Tell people about your CCA…"
        />
        <p className="text-right text-xs text-gray-500">
          {description.length}/{CCA_DESCRIPTION_MAX}
        </p>
      </div>

      {fieldError && <p className="text-sm text-red-600">{fieldError}</p>}
      {serverError && <p className="text-sm text-red-600">{serverError}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending || !dirty}>
          {update.isPending ? "Saving…" : "Save description"}
        </Button>
        {saved && !dirty && (
          <span className="text-sm text-emerald-700">Saved.</span>
        )}
      </div>

      {profile.data?.updatedAt && (
        <p className="text-xs text-gray-400">
          Last edited {new Date(profile.data.updatedAt).toLocaleString()}
          {profile.data.updatedBy ? ` by ${profile.data.updatedBy}` : ""}.
        </p>
      )}
    </form>
  );
}
