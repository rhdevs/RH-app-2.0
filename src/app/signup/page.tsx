"use client";

import React, { useState } from "react";
import {
  Mail,
  Lock,
  Eye,
  EyeOff,
  User,
  MessageCircle,
  Building,
  FileText,
  ArrowLeft,
} from "lucide-react";
import Header from "../_components/header";
import Toast from "../_components/Toast";
import { useRouter } from "next/navigation";
import { validatePassword } from "~/lib/schemas/password";

const SignUpPage = () => {
  const [formData, setFormData] = useState({
    email: "",
    password: "",
    confirmPassword: "",
    fullName: "",
    bio: "",
    blockNumber: "",
    telegramHandle: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [showPassword2, setShowPassword2] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [nextPage, setNextPage] = useState<boolean>(false);
  const router = useRouter();

  const blockOptions = [2, 3, 4, 5, 6, 7, 8];

  const handleInputChange = (
    e: React.ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const onSubmitStep1 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      formData.email === "" ||
      formData.password === "" ||
      formData.confirmPassword === ""
    ) {
      setToastContent("Please fill in required field!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }

    // Mirrors the server rule via the SHARED policy (src/lib/schemas/password).
    // Advice only — src/app/api/register/route.ts is the enforcement point.
    // Checked BEFORE the match test so someone typing a too-short password
    // twice is told the actual problem rather than being waved through step 1
    // and rejected by the API two screens later.
    const policyError = validatePassword(formData.password);
    if (policyError) {
      setToastContent(policyError);
      setToastOpen(true);
      setToastType("danger");
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setToastContent("Passwords do not match!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }

    setNextPage(true);
  };

  const onSubmitStep2 = async (e: React.FormEvent) => {
    console.log("asdadasd");
    e.preventDefault();
    if (
      formData.fullName === "" ||
      formData.bio === "" ||
      formData.blockNumber === "" ||
      formData.telegramHandle === ""
    ) {
      setToastContent("Please fill in all required fields!");
      setToastOpen(true);
      setToastType("danger");
      return;
    }

    try {
      setIsLoading(true);
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      setIsLoading(false);
      if (res.ok) {
        setToastContent("Account created successfully!");
        setToastOpen(true);
        setToastType("success");

        setTimeout(() => {
          router.push("/login");
        }, 1500);
      } else {
        const data = await res.json();
        setToastContent(data.error ?? "Something went wrong!");
        setToastType("danger");
        setToastOpen(true);
      }
    } catch {
      setToastContent(
        "There is something wrong with the app! Please contact RHDevs!",
      );
      setToastOpen(true);
      setToastType("danger");
    }
  };

  const goBackToStep1 = () => {
    setNextPage(false);
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
      <div className="mb-16 mt-10 flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="mb-8 text-center">
            <h1 className="mb-2 text-3xl font-bold text-gray-900">Welcome</h1>
            <p className="text-gray-600">
              {nextPage
                ? "Tell us more about yourself"
                : "Sign up get your Raffles Hall account"}
            </p>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-white p-8 shadow-xl">
            {!nextPage ? (
              // Step 1: Account Information
              <div className="space-y-6">
                <div className="space-y-2">
                  <label
                    htmlFor="email"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Email Address
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
                    htmlFor="password"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Password
                  </label>
                  <div className="relative">
                    <Lock
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type={showPassword ? "text" : "password"}
                      id="password"
                      name="password"
                      value={formData.password}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-12 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Enter your password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 transform text-gray-400 transition-colors hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="confirmPassword"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type={showPassword2 ? "text" : "password"}
                      id="confirmPassword"
                      name="confirmPassword"
                      value={formData.confirmPassword}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-12 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Confirm your password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword2(!showPassword2)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 transform text-gray-400 transition-colors hover:text-gray-600"
                    >
                      {showPassword2 ? <EyeOff size={20} /> : <Eye size={20} />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  onClick={onSubmitStep1}
                  className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white shadow-lg transition-all duration-200 hover:bg-emerald-700 hover:shadow-xl active:scale-95 active:transform"
                >
                  Continue
                </button>
              </div>
            ) : (
              // Step 2: Personal Information
              <div className="space-y-6">
                <div className="mb-4 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={goBackToStep1}
                    className="flex items-center space-x-2 text-gray-600 transition-colors hover:text-gray-800"
                  >
                    <ArrowLeft size={20} />
                    <span>Back</span>
                  </button>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="fullName"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Full Name
                  </label>
                  <div className="relative">
                    <User
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type="text"
                      id="fullName"
                      name="fullName"
                      value={formData.fullName}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Enter your full name"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="bio"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Bio
                  </label>
                  <div className="relative">
                    <FileText
                      className="absolute left-3 top-3 transform text-gray-400"
                      size={20}
                    />
                    <textarea
                      id="bio"
                      name="bio"
                      value={formData.bio}
                      onChange={handleInputChange}
                      required
                      rows={3}
                      className="w-full resize-none rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Tell us about yourself..."
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="blockNumber"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Block Number
                  </label>
                  <div className="relative">
                    <Building
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <select
                      id="blockNumber"
                      name="blockNumber"
                      value={formData.blockNumber}
                      onChange={handleInputChange}
                      required
                      className="w-full appearance-none rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                    >
                      <option value="">Select your block</option>
                      {blockOptions.map((block) => (
                        <option key={block} value={block}>
                          Block {block}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="telegramHandle"
                    className="block text-sm font-medium text-gray-700"
                  >
                    Telegram Handle (without @)
                  </label>
                  <div className="relative">
                    <MessageCircle
                      className="absolute left-3 top-1/2 -translate-y-1/2 transform text-gray-400"
                      size={20}
                    />
                    <input
                      type="text"
                      id="telegramHandle"
                      name="telegramHandle"
                      value={formData.telegramHandle}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-xl border border-gray-300 bg-gray-50 py-3 pl-10 pr-4 transition-all duration-200 focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-500"
                      placeholder="Telegram handle (without @)"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  onClick={onSubmitStep2}
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
                      <span>Creating Account...</span>
                    </div>
                  ) : (
                    "Create Account"
                  )}
                </button>
              </div>
            )}

            <div className="mt-8 text-center">
              <p className="text-gray-600">
                Already have an account?{" "}
                <span
                  onClick={() => router.push("/login")}
                  className="cursor-pointer font-semibold text-emerald-600 transition-colors hover:text-emerald-700"
                >
                  Sign in
                </span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default SignUpPage;
