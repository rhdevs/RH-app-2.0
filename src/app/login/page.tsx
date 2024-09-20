"use client";

import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const router = useRouter();

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    console.log("Login successful");
  };

  const handleForgotPassword = () => {
    router.push("/forgot-password");
  };

  const handleSignUp = () => {
    router.push("/signup");
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="IamKeith@example.com"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={username}
            onChange={handleUsernameChange}
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={password}
            onChange={handlePasswordChange}
          />
        </div>
        <Button
          type="submit"
          className="w-full rounded-md bg-indigo-600 py-2 text-white transition-colors hover:bg-indigo-700"
        >
          Login
        </Button>
        <div className="mt-4 flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={handleForgotPassword}
            className="text-indigo-600 hover:underline"
          >
            Forgot password?
          </button>
          <button
            type="button"
            onClick={handleSignUp}
            className="text-indigo-600 hover:underline"
          >
            Sign up
          </button>
        </div>
      </div>
    </form>
  );
}

const LoginPage: React.FC = () => {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-3xl font-bold text-gray-800">
          Login
        </h1>
        <p className="mb-8 text-center text-sm text-gray-600">
          Enter your email and password to log in to your account.
        </p>
        <LoginForm />
      </div>
    </div>
  );
};

export default LoginPage;
