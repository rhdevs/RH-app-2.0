"use client";

import { useState } from "react";
import { useForm, type SubmitHandler } from "react-hook-form";
import { useRouter } from "next/navigation";
import Image from "next/image";
import rafflesHallLogo from "/public/raffles-hall-logo.svg";
import Modal from "@/app/_components/modal";

interface LoginInput {
  email: string;
  password: string;
}

const LoginPage = () => {
  const router = useRouter();
  const { register, handleSubmit } = useForm<LoginInput>();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMessage, setModalMessage] = useState("");
  const [modalTitle, setModalTitle] = useState("");

  const onSubmit: SubmitHandler<LoginInput> = async (data) => {
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const result = await res.json();

      if (res.ok) {
        localStorage.setItem("userEmail", data.email);

        setModalTitle("Success");
        setModalMessage("Login successful! Redirecting...");
        setIsModalOpen(true);

        setTimeout(() => {
          router.push("/"); // Redirect to home
        }, 1500);
      } else {
        setModalTitle("Error");
        setModalMessage(result.error || "Invalid email or password.");
        setIsModalOpen(true);

        setTimeout(() => {
          setIsModalOpen(false);
        }, 1500);
      }
    } catch (err) {
      console.error(err);
      setModalMessage("Network or server error.");
      setIsModalOpen(true);

      setTimeout(() => {
        setIsModalOpen(false);
      }, 1500);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gray-500">
      <div className="flex w-full max-w-md flex-col">
        {/* Logo Section */}
        <div className="mb-6 mr-20 flex w-fit items-center rounded-lg bg-white p-2">
          <Image
            src={rafflesHallLogo}
            alt="Raffles Hall Logo"
            width={100}
            className="object-contain"
          />
          <h1 className="mr-4 text-5xl italic text-[#44403c]">RHApp</h1>
        </div>

        {/* Login Form */}
        <div className="relative z-10 w-full max-w-md overflow-hidden rounded-xl bg-white shadow-lg">
          <div className="p-6">
            <h2 className="mb-6 text-3xl font-bold text-gray-800">Login</h2>

            <form className="space-y-4" onSubmit={handleSubmit(onSubmit)}>
              <div>
                <input
                  type="text"
                  placeholder="Email"
                  className="w-full rounded-[1vw] border bg-white px-4 py-2 text-black placeholder-gray-700 focus:outline-none"
                  {...register("email", { required: true })}
                />
              </div>

              <div>
                <input
                  type="password"
                  placeholder="Password"
                  className="w-full rounded-[1vw] border bg-white px-4 py-2 text-black placeholder-gray-700 focus:outline-none"
                  {...register("password", { required: true })}
                />
              </div>

              <button
                type="submit"
                className="w-full rounded bg-green-700 py-2 text-white hover:bg-green-800"
              >
                Login
              </button>

              <button
                className="w-full rounded border bg-white py-2 text-zinc-700 hover:bg-zinc-200"
                disabled={true}
              >
                <span className="mr-2 font-bold text-red-700">G</span> Sign in
                with Google
              </button>
              <Modal
                isOpen={isModalOpen}
                title={modalTitle}
                message={modalMessage}
                onClose={() => setIsModalOpen(false)}
              />
            </form>

            <div className="mt-4 text-center">
              <a
                href="/signup"
                className="text-sm text-gray-600 hover:underline"
              >
                Create Account
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
