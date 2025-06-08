"use client";

import React, { useState } from "react";

const SignupPage: React.FC = () => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleEmailChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(e.target.value);
  };

  const handlePasswordChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Add your signup logic here
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center">
      <div
        className="absolute inset-0 z-0 bg-cover bg-no-repeat"
        style={{
          backgroundImage: 'url("rh-sunset.png")',
          filter: "blur(4px)",
        }}
      ></div>

      <div className="relaive z-10 w-full max-w-md overflow-hidden rounded-xl bg-white shadow-lg">
        {/* Top Image Section */}
        <div
          className="h-56 w-full bg-cover bg-center"
          style={{
            backgroundImage: 'url("raffles-hall.png")',
          }}
        ></div>

        {/* Form Section */}
        <div className="p-6">
          <h2 className="mb-6 text-3xl font-bold text-gray-800">
            Create Account
          </h2>

          <form className="space-y-4">
            <div>
              <input
                type="text"
                placeholder="Email"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
                // {...register("email")}
              />
            </div>

            <div>
              <input
                type="password"
                placeholder="Password"
                className="bg-white-200 placeholder-grey-700 w-full rounded-[1vw] border px-4 py-2 text-black focus:outline-none"
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
