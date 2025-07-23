import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";

import { TRPCReactProvider } from "~/trpc/react";

import SessionProviderWrapper from "./sessionProviderWrapper";

export const metadata: Metadata = {
  title: "RHApp",
  description: "Created by RHDevs",
  icons: [{ rel: "icon", url: "/raffles-hall-logo.svg" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable}`}>
      <body className="min-h-screen bg-gray-100">
        <SessionProviderWrapper>
          <TRPCReactProvider>{children}</TRPCReactProvider>
          <footer className="w-full bg-emerald-800 py-4 text-center text-sm text-white fixed bottom-0">
            Thanks for using the RH App! It’s still new – feel free to report
            bugs or suggest features via Telegram:
            <a
              href="https://t.me/lcw14"
              className="ml-1 underline hover:text-emerald-300"
            >
              @lcw14
            </a>
          </footer>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}
