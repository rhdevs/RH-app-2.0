import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";

import { TRPCReactProvider } from "~/trpc/react";

import SessionProviderWrapper from "./sessionProviderWrapper";
import MatricGate from "./_components/MatricGate";

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
          <TRPCReactProvider>
            <MatricGate>{children}</MatricGate>
          </TRPCReactProvider>
          <footer className="fixed bottom-0 w-full bg-emerald-800 py-4 text-center text-sm text-white">
            Thanks for using the RH App! Feel free to report bugs or suggest
            features via form:
            <a
              href="https://forms.gle/foqWNsYHDhgWFjrK8"
              target="_blank"
              className="ml-1 underline hover:text-emerald-300"
            >
              here
            </a>
          </footer>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}
