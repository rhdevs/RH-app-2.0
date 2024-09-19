"use client";

import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import usePasswordValidation from "@/hooks/usePasswordValidation";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { validationResult, validatePassword } =
    usePasswordValidation(password);

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    validatePassword();
    if (validationResult.isValid) {
      console.log("Login successful");
    } else {
      console.log("Validation failed:", validationResult.errors);
    }
  };

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div className="space-y-4">
        <div className="space-y-2">
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
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={password}
            onChange={handlePasswordChange}
          />
          {validationResult.errors.length > 0 && (
            <ul className="mt-2 text-sm text-red-500">
              {validationResult.errors.map((error, index) => (
                <li key={index}>{error}</li>
              ))}
            </ul>
          )}
        </div>
        <Button
          type="submit"
          className="w-full rounded-md bg-indigo-600 py-2 text-white transition-colors hover:bg-indigo-700"
        >
          Login
        </Button>
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
