"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { IdCard } from "lucide-react";
import Toast from "../../_components/Toast";
import { api } from "~/trpc/react";

// Same validator the server (user.setMatric) uses — kept identical so the
// client never accepts something the server rejects.
const MATRIC_REGEX = /^A\d{7}[A-Z]$/;

export default function MatricOnboardingPage() {
  const router = useRouter();
  const { update } = useSession();
  const [matric, setMatric] = useState("");
  const [toastOpen, setToastOpen] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");

  const setMatricMutation = api.user.setMatric.useMutation({
    onSuccess: async () => {
      // Force the session callback to re-run so hasMatric becomes true before
      // we navigate; otherwise the MatricGate could bounce us straight back.
      await update();
      router.replace("/");
    },
    onError: (e) => {
      setToastType("danger");
      setToastContent(e.message || "Could not save matric number.");
      setToastOpen(true);
    },
  });

  const onSubmit = () => {
    const value = matric.trim().toUpperCase();
    if (!MATRIC_REGEX.test(value)) {
      setToastType("danger");
      setToastContent("Enter a valid matric number, e.g. A0234567X.");
      setToastOpen(true);
      return;
    }
    setMatricMutation.mutate({ matric: value });
  };

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
            <IdCard className="mx-auto mb-3 text-emerald-600" size={40} />
            <h1 className="mb-2 text-2xl font-bold text-gray-900">
              One more step
            </h1>
            <p className="text-gray-600">
              Enter your matriculation number to finish setting up your account.
            </p>
          </div>

          <input
            value={matric}
            onChange={(e) => setMatric(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            placeholder="A0234567X"
            maxLength={9}
            className="w-full rounded-xl border border-gray-300 bg-gray-50 px-4 py-3 uppercase tracking-widest transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
          />

          <button
            onClick={onSubmit}
            disabled={setMatricMutation.isPending}
            className="mt-6 w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700 disabled:bg-gray-400"
          >
            {setMatricMutation.isPending ? "Saving..." : "Save and continue"}
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
