"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { UserCheck } from "lucide-react";
import Toast from "../../_components/Toast";
import { api } from "~/trpc/react";
import {
  completeProfileInput,
  PROFILE_COMPLETION_COPY,
  type ProfileCompletionField,
} from "~/lib/schemas/profile";

/**
 * Post-merge profile completion. Reached from MatricGate when the session's
 * `profileNeedsFields` is non-empty, which happens only for the handful of
 * accounts the duplicate-account merge touched and could not fully reconcile.
 *
 * The field list comes from the SERVER (`user.getProfileCompletion`), not from
 * the session, so the form renders the authoritative list rather than whatever
 * a 30-day-old JWT happens to carry — and so a field resolved in another tab
 * disappears here on the next fetch.
 *
 * Validation is `completeProfileInput.safeParse` — the same schema the mutation
 * parses server-side — so the client cannot accept something the server will
 * reject, and there is no second copy of the matric or Telegram rule to drift.
 */
export default function CompleteProfilePage() {
  const router = useRouter();
  const { update } = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [toastOpen, setToastOpen] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");

  const showError = (msg: string) => {
    setToastType("danger");
    setToastContent(msg);
    setToastOpen(true);
  };

  const status = api.user.getProfileCompletion.useQuery();
  const needsFields = status.data?.needsFields ?? [];

  const completeProfile = api.user.completeProfile.useMutation({
    onSuccess: async () => {
      // Force the session callback to re-run so `profileNeedsFields` empties
      // before we navigate; otherwise MatricGate bounces us straight back here.
      await update();
      router.replace("/");
    },
    onError: (e) => showError(e.message || "Could not save your details."),
  });

  const onSubmit = () => {
    // Only send what we were actually asked for. The server intersects this
    // with the stored list again — this is convenience, not the guard.
    const payload: Record<string, string> = {};
    for (const field of needsFields) {
      payload[field] = values[field] ?? "";
    }

    const parsed = completeProfileInput.safeParse(payload);
    if (!parsed.success) {
      showError(
        parsed.error.issues[0]?.message ?? "Please check the details above.",
      );
      return;
    }
    completeProfile.mutate(parsed.data);
  };

  // Nothing outstanding: either the query is still loading, or somebody
  // navigated here directly. Render nothing rather than an empty card.
  if (status.isPending) return null;
  if (needsFields.length === 0) {
    return (
      <div className="mt-16 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 text-center shadow-xl">
          <h1 className="mb-2 text-2xl font-bold text-gray-900">
            You&apos;re all set
          </h1>
          <p className="text-gray-600">
            There&apos;s nothing left to confirm on your account.
          </p>
          <button
            onClick={() => router.replace("/")}
            className="mt-6 w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700"
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="mt-16 flex items-center justify-center p-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
          <div className="mb-6 text-center">
            <UserCheck className="mx-auto mb-3 text-emerald-600" size={40} />
            <h1 className="mb-2 text-2xl font-bold text-gray-900">
              Confirm a couple of details
            </h1>
            <p className="text-gray-600">
              You had two accounts on the RH App, and we&apos;ve combined them
              into this one so your bookings and posts are all in one place.
            </p>
            <p className="mt-3 text-gray-600">
              The two accounts didn&apos;t list the same details below, and we
              couldn&apos;t tell which was current — so we&apos;d rather ask you
              than guess. Enter them once here and you&apos;re done.
            </p>
          </div>

          <div className="space-y-5">
            {needsFields.map((field: ProfileCompletionField) => {
              const copy = PROFILE_COMPLETION_COPY[field];
              return (
                <div key={field}>
                  <label
                    htmlFor={field}
                    className="mb-1 block text-sm font-semibold text-gray-900"
                  >
                    {copy.label}
                  </label>
                  <p className="mb-2 text-sm text-gray-500">{copy.help}</p>
                  <input
                    id={field}
                    value={values[field] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({
                        ...v,
                        [field]:
                          field === "matric"
                            ? e.target.value.toUpperCase()
                            : e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onSubmit();
                    }}
                    placeholder={copy.placeholder}
                    maxLength={field === "matric" ? 9 : 32}
                    className={`w-full rounded-xl border border-gray-300 bg-gray-50 px-4 py-3 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500 ${
                      field === "matric" ? "uppercase tracking-widest" : ""
                    }`}
                  />
                </div>
              );
            })}
          </div>

          <button
            onClick={onSubmit}
            disabled={completeProfile.isPending}
            className="mt-6 w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700 disabled:bg-gray-400"
          >
            {completeProfile.isPending ? "Saving..." : "Save and continue"}
          </button>

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="mt-3 w-full text-sm text-gray-500 transition-colors hover:text-gray-700"
          >
            Log out
          </button>
        </div>
      </div>
    </>
  );
}
