"use client";

import React, { useEffect, useState } from "react";
import { Mail, ArrowLeft, Lock } from "lucide-react";
import Header from "../_components/header";
import Toast from "../_components/Toast";
import { useRouter } from "next/navigation";

const LoginPage = () => {
  const [formData, setFormData] = useState({
    email: "",
    personalEmail: ""
  });
  const [isLoading, setIsLoading] = useState(false);
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [verificationCodeSent, setVerificationCodeSent] =
    useState<boolean>(false);
  const [verificationCode, setVerificationCode] = useState<string>("");
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [canResend, setCanResend] = useState<boolean>(true);
  const [hasVerified, setHasVerified] = useState<boolean>(false);
  const [resetPassword, setResetPassword] = useState<string>("");

  const router = useRouter();

  const handleResend = async () => {
    setCanResend(false);
    const res = await fetch("/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formData),
    });
    if (res.ok) {
      setToastContent("Verification code has been sent to your email!");
      setToastOpen(true);
      setToastType("success");
      setVerificationCodeSent(true);
    }
  };

  const handleInputChange = (e: any) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.email === "" || formData.personalEmail === "") {
      setToastContent("Please fill in required field!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }
    try {
      setIsLoading(true);
      const res = await fetch("/api/reset-password/request-verification-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      setIsLoading(false);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        alert("Unexpected response from server.");
        return;
      }
      if (res.ok) {
        setToastContent("Verification code has been sent to your email!");
        setToastOpen(true);
        setToastType("success");
        setVerificationCodeSent(true);
      } else {
        setToastContent("Email does not exist!");
        setToastOpen(true);
        setToastType("danger");
      }
    } catch (err) {
      setToastContent(
        "There is something wrong with the app! Please contact RHDevs!",
      );
      setToastOpen(true);
      setToastType("danger");
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    const res = await fetch("/api/reset-password/verify-verification-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: verificationCode, email: formData.email }),
    });
    setIsVerifying(false);
    if (!res.ok) {
      const data = await res.json();
      setToastContent(data.error);
      setToastOpen(true);
      setToastType("danger");
    } else {
      setHasVerified(true);
    }
  };

  const onResetPassword = async () => {
    if (resetPassword === "") {
      setToastContent("New password cannot be empty!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }
    setIsLoading(true);
    const res = await fetch("/api/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: resetPassword, email: formData.email }),
    });
    setIsLoading(false);
    if (!res.ok) {
      const data = await res.json();
      setToastContent(data.error);
      setToastOpen(true);
      setToastType("danger");
    } else {
      setToastContent("Your password has been updated!");
      setToastOpen(true);
      setToastType("success");
      setTimeout(() => {
        router.push("/login");
      }, 1500);
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
      <Header currentPage="login" />
      {hasVerified ? (
        <div className="mt-10 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold text-gray-900">
                Forgot Password?
              </h1>
              <p className="text-gray-600">No worries</p>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
              <div className="space-y-6">
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Reset your password
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
                      value={resetPassword}
                      onChange={(e) => setResetPassword(e.target.value)}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Reset your password"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  onClick={onResetPassword}
                  disabled={isLoading}
                  className={`w-full rounded-xl px-4 py-3 font-semibold transition-all duration-200 ${
                    isLoading
                      ? "cursor-not-allowed bg-gray-400"
                      : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 active:transform"
                  } text-white shadow-lg hover:shadow-xl`}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-2">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                      <span>Resetting your password...</span>
                    </div>
                  ) : (
                    "Reset"
                  )}
                </button>
              </div>

              <div className="mt-8 text-center">
                <span
                  onClick={() => router.push("/login")}
                  className="cursor-pointer font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  Back to login
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : verificationCodeSent ? (
        <div className="mt-10 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold text-gray-900">
                Check Your Email
              </h1>
              <p className="text-gray-600">
                We sent a 6-digit code to <br />
                <span className="font-semibold text-gray-900">
                  {formData.email}
                </span>
              </p>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
              <div className="space-y-6">
                <div className="space-y-4">
                  <label className="block text-center text-sm font-medium text-gray-700">
                    Enter Verification Code
                  </label>

                  <div className="flex justify-center">
                    <input
                      type="text"
                      maxLength={6}
                      value={verificationCode}
                      onChange={(e) => {
                        setVerificationCode(e.target.value.toUpperCase());
                      }}
                      className="h-12 w-48 rounded-xl border-2 border-gray-300 bg-gray-50 text-center text-xl font-bold tracking-widest transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-200"
                      placeholder="ABC123"
                    />
                  </div>
                </div>

                <button
                  onClick={handleVerify}
                  disabled={isVerifying || verificationCode.length !== 6}
                  className={`w-full rounded-xl px-4 py-3 font-semibold transition-all duration-200 ${
                    isVerifying || verificationCode.length !== 6
                      ? "cursor-not-allowed bg-gray-400"
                      : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 active:transform"
                  } text-white shadow-lg hover:shadow-xl`}
                >
                  {isVerifying ? (
                    <div className="flex items-center justify-center space-x-2">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                      <span>Verifying...</span>
                    </div>
                  ) : (
                    "Verify Code"
                  )}
                </button>

                <div className="text-center">
                  <p className="text-sm text-gray-600">
                    Didn't receive the code?{" "}
                    {canResend ? (
                      <button
                        onClick={handleResend}
                        className="font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                      >
                        Resend Code
                      </button>
                    ) : (
                      <span className="font-semibold">Code Resent</span>
                    )}
                  </p>
                </div>
              </div>

              <div className="mt-8 text-center">
                <button
                  onClick={() => {
                    setVerificationCodeSent(false);
                    setVerificationCode("");
                  }}
                  className="mx-auto flex items-center justify-center space-x-2 font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  <ArrowLeft size={16} />
                  <span>Back to email</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-10 flex items-center justify-center p-4">
          <div className="w-full max-w-md">
            <div className="mb-8 text-center">
              <h1 className="mb-2 text-3xl font-bold text-gray-900">
                Forgot Password?
              </h1>
              <p className="text-gray-600">No worries</p>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
              <div className="space-y-6">
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
                      value={formData.email}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Enter your email"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Personal Email Address
                  </label>
                  <div className="relative">
                    <Mail
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type="email"
                      id="personalEmail"
                      name="personalEmail"
                      value={formData.personalEmail}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Enter your personal email"
                    />
                  </div>
                </div>
                <span className="text-xs">
                  (Note: Due to strict email filtering policies by NUS, we’re
                  unable to deliver password reset emails to @u.nus.edu
                  addresses. To ensure you receive your verification code,
                  please provide a personal email address (e.g. Gmail, Outlook,
                  etc.) along with your NUS email.)
                </span>

                <button
                  type="submit"
                  onClick={onSubmit}
                  disabled={isLoading}
                  className={`w-full rounded-xl px-4 py-3 font-semibold transition-all duration-200 ${
                    isLoading
                      ? "cursor-not-allowed bg-gray-400"
                      : "bg-emerald-600 hover:bg-emerald-700 active:scale-95 active:transform"
                  } text-white shadow-lg hover:shadow-xl`}
                >
                  {isLoading ? (
                    <div className="flex items-center justify-center space-x-2">
                      <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
                      <span>Sending Verification Code...</span>
                    </div>
                  ) : (
                    "Send Verification Code"
                  )}
                </button>
              </div>

              <div className="mt-8 text-center">
                <span
                  onClick={() => router.push("/login")}
                  className="cursor-pointer font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  Back to login
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default LoginPage;
