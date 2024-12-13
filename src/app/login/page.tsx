"use client";

import React, { useState } from "react";

const LoginPage: React.FC = () => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const handleUsernameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(event.target.value);
  };

  const handlePasswordChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // Add your login logic here
  };

  return (
    <div className="align-center flex flex-col justify-center p-10 text-center">
      <h2 className="text-lg font-bold text-black">Login</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <label htmlFor="username">Username:</label>
          <input
            type="text"
            id="username"
            className="rounded border-2"
            value={username}
            onChange={handleUsernameChange}
          />
        </div>
        <div>
          <label htmlFor="password">Password:</label>
          <input
            type="password"
            id="password"
            className="rounded border-2"
            value={password}
            onChange={handlePasswordChange}
          />
        </div>
        <button className="align-center bg-customBlue hover:bg-customWhite hover:text-customBlue inline-block min-h-10 justify-center rounded-3xl border border-black px-5 text-center text-black hover:scale-110">
          Login
        </button>
      </form>
    </div>
  );
};

export default LoginPage;
