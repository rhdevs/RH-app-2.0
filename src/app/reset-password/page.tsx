"use client";

import React, { Suspense, useEffect, useState } from "react";
import { Mail, Lock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import Header from "../_components/header";
import Toast from "../_components/Toast";

const RequestResetForm = () => {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  // Seconds left before "Resend link" can be clicked again (#UX: 60s cooldown).
  const [cooldown, setCooldown] = useState(0);
  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState(false);
  const router = useRouter();

  // Tick the resend cooldown down to zero, one second at a time.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const showToast = (content: string, type: "success" | "danger") => {
    setToastContent(content);
    setToastType(type);
    setToastOpen(true);
  };

  const requestLink = async (e?: React.FormEvent) => {
    e?.preventDefault();
    // Block resends while the cooldown is still running.
    if (cooldown > 0) return;
    if (email.trim() === "") {
      showToast("Please enter your email!", "danger");
      return;
    }
    try {
      setIsLoading(true);
      const res = await fetch(
        "/api/reset-password/request-verification-code",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );
      setIsLoading(false);
      if (res.ok) {
        setSent(true);
        setCooldown(60);
        showToast("If that account exists, a reset link is on its way.", "success");
      } else {
        const data = (await res.json()) as { error?: string };
        showToast(data.error ?? "Something went wrong.", "danger");
      }
    } catch {
      setIsLoading(false);
      showToast("There is something wrong with the app! Please contact RHDevs!", "danger");
    }
  };

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="mt-10 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-3xl font-bold text-gray-900">
              Forgot Password?
            </h1>
            <p className="text-gray-600">
              Enter your RHApp email and we&apos;ll send a secure reset link to it.
            </p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
            {sent ? (
              <div className="space-y-4 text-center">
                <p className="text-gray-700">
                  If an account exists for{" "}
                  <span className="font-semibold text-gray-900">{email}</span>,
                  a password reset link has been sent. The link expires in 15
                  minutes.
                </p>
                <button
                  onClick={() => requestLink()}
                  disabled={cooldown > 0}
                  className={`font-semibold transition-colors ${
                    cooldown > 0
                      ? "cursor-not-allowed text-gray-400"
                      : "text-emerald-600 hover:text-emerald-700"
                  }`}
                >
                  {cooldown > 0 ? `Resend link in ${cooldown}s` : "Resend link"}
                </button>
              </div>
            ) : (
              <form onSubmit={requestLink} className="space-y-6">
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700"
                  >
                    RHApp Email Address (@u.nus.edu)
                  </label>
                  <div className="relative">
                    <Mail
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type="email"
                      id="email"
                      name="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Enter your email"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className={`w-full rounded-xl px-4 py-3 font-semibold transition-all duration-200 ${
                    isLoading
                      ? "cursor-not-allowed bg-gray-400"
                      : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 active:transform"
                  } text-white shadow-lg hover:shadow-xl`}
                >
                  {isLoading ? "Sending reset link..." : "Send Reset Link"}
                </button>
              </form>
            )}

            <div className="mt-8 text-center">
              <button
                onClick={() => router.push("/login")}
                className="cursor-pointer font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
              >
                Back to login
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

const SetNewPasswordForm = ({ token }: { token: string }) => {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [toastContent, setToastContent] = useState("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState(false);
  const router = useRouter();

  const showToast = (content: string, type: "success" | "danger") => {
    setToastContent(content);
    setToastType(type);
    setToastOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      showToast("Password should be at least 8 characters long.", "danger");
      return;
    }
    if (password !== confirm) {
      showToast("Passwords do not match.", "danger");
      return;
    }
    setIsLoading(true);
    const res = await fetch("/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setIsLoading(false);
    if (res.ok) {
      showToast("Your password has been updated!", "success");
      setTimeout(() => router.push("/login"), 1500);
    } else {
      const data = (await res.json()) as { error?: string };
      showToast(data.error ?? "Could not reset password.", "danger");
    }
  };

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />
      <div className="mt-10 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-3xl font-bold text-gray-900">
              Reset Your Password
            </h1>
            <p className="text-gray-600">Choose a new password for your account.</p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
            <form onSubmit={submit} className="space-y-6">
              <div className="space-y-2">
                <label
                  htmlFor="password"
                  className="block text-sm font-medium text-gray-700"
                >
                  New password
                </label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                    size={20}
                  />
                  <input
                    type="password"
                    id="password"
                    name="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                    placeholder="At least 8 characters"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="confirm"
                  className="block text-sm font-medium text-gray-700"
                >
                  Confirm new password
                </label>
                <div className="relative">
                  <Lock
                    className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                    size={20}
                  />
                  <input
                    type="password"
                    id="confirm"
                    name="confirm"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                    placeholder="Re-enter your new password"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className={`w-full rounded-xl px-4 py-3 font-semibold transition-all duration-200 ${
                  isLoading
                    ? "cursor-not-allowed bg-gray-400"
                    : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 active:transform"
                } text-white shadow-lg hover:shadow-xl`}
              >
                {isLoading ? "Resetting your password..." : "Reset Password"}
              </button>
            </form>

            <div className="mt-8 text-center">
              <button
                onClick={() => router.push("/login")}
                className="cursor-pointer font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
              >
                Back to login
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

const ResetPasswordInner = () => {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  return token ? <SetNewPasswordForm token={token} /> : <RequestResetForm />;
};

const ResetPasswordPage = () => {
  return (
    <>
      <Header currentPage="login" />
      <Suspense fallback={null}>
        <ResetPasswordInner />
      </Suspense>
    </>
  );
};

export default ResetPasswordPage;
