"use client";

import React, { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import usePasswordValidation from "@/hooks/usePasswordValidation";

export function SignUpForm() {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { validationResult, validatePassword } =
    usePasswordValidation(password);

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(event.target.value);
  };

  const handleEmailChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEmail(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleConfirmPasswordChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    setConfirmPassword(event.target.value);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    validatePassword();
    if (validationResult.isValid && password === confirmPassword) {
      console.log("Sign up successful");
    } else {
      console.log("Validation failed:", validationResult.errors);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div>
        <div className="space-y-2">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            type="text"
            placeholder="Your Username"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={username}
            onChange={handleUsernameChange}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="IamKeith@example.com"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={email}
            onChange={handleEmailChange}
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
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">Confirm Password</Label>
          <Input
            id="confirm-password"
            type="password"
            required
            className="w-full rounded-md border border-gray-300 p-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            value={confirmPassword}
            onChange={handleConfirmPasswordChange}
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
          Sign Up
        </Button>
      </div>
    </form>
  );
}

const SignUpPage: React.FC = () => {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-100 px-4">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-3xl font-bold text-gray-800">
          Sign Up
        </h1>
        <p className="mb-8 text-center text-sm text-gray-600">
          Create a new account by filling out the form below.
        </p>
        <SignUpForm />
      </div>
    </div>
  );
};

export default SignUpPage;
