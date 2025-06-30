"use client";

import React, { useState } from "react";
import Modal from "@/app/_components/modal";
import { fa } from "@faker-js/faker";

const SignupPage: React.FC = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMessage, setModalMessage] = useState("");
  const [modalTitle, setModalTitle] = useState("");

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  };

  const [successMessage, setSuccessMessage] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, confirmPassword }),
      });

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.error("Raw response:", text);
        alert("Unexpected response from server.");
        return;
      }
      if (res.ok) {
        setModalTitle("Success");
        setModalMessage("Account created successfully!");
        setIsModalOpen(true);
        setTimeout(() => {
          window.location.href = "/";
        }, 2000);
      } else {
        setModalTitle("Error");
        setModalMessage(
          data.error || "An account with this email already exists.",
        );
        setIsModalOpen(true);
        setTimeout(() => {
          setIsModalOpen(false);
        }, 2000);
      }
    } catch (err) {
      console.error(err);
      alert("Network or server error.");
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-gray-500">
      <div className="relaive z-10 w-full max-w-md overflow-hidden rounded-xl bg-white shadow-lg">
        {" "}
        <div
          className="h-56 w-full bg-cover bg-[left_20%]"
          style={{
            backgroundImage: 'url("raffles-hall.png")',
          }}
        ></div>
        <div className="p-6">
          <h2 className="mb-6 text-3xl font-bold text-gray-800">
            Create Account
          </h2>

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <input
                type="text"
                placeholder="Email (@u.nus.edu)"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                onChange={(e) => setEmail(e.target.value)}
                // {...register("email")}
              />
            </div>

            <div>
              <input
                type="password"
                placeholder="Password"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                onChange={(e) => setPassword(e.target.value)}

                // {...register("password")}
              />
            </div>

            <div>
              <input
                type="password"
                placeholder="Confirm Password"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                onChange={(e) => setConfirmPassword(e.target.value)}
                // {...register("password")}
              />
            </div>

            {/* <div className="flex items-center justify-between text-sm text-gray-600">
                  <label className="flex items-center">
                    <input type="checkbox" className="mr-2" /> remember me
                  </label>
                  <a href="#" className="hover:underline">
                    forgot password
                  </a>
                </div> */}

            <button
              type="submit"
              className="w-full rounded bg-green-700 py-2 text-white hover:bg-green-800"
              // onClick={handleSubmit(onSubmit)}
            >
              Sign Up
            </button>

            <button
              className="w-full rounded border bg-white py-2 text-zinc-700 hover:bg-zinc-200"
              disabled={true}
              // onClick={() => signIn("google")}
            >
              <span className="mr-2 font-bold text-red-700">G</span> Sign Up
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
            <span className="text-sm text-gray-600">
              Already have an account?{" "}
            </span>
            <a
              href="/login"
              className="text-sm text-emerald-800 hover:underline"
            >
              Login
            </a>
          </div>
        </div>
      </div>
    </div>
    // <div>
    //   <h2>Signup Page</h2>
    //   <form onSubmit={handleSubmit}>
    //     <div>
    //       <label>Email:</label>
    //       <input type="email" value={email} onChange={handleEmailChange} />
    //     </div>
    //     <div>
    //       <label>Password:</label>
    //       <input
    //         type="password"
    //         value={password}
    //         onChange={handlePasswordChange}
    //       />
    //     </div>
    //     <button type="submit">Sign Up</button>
    //   </form>
    // </div>
  );
};

export default SignupPage;
