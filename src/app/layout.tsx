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
      <body className="flex min-h-screen flex-col bg-gray-100">
        <SessionProviderWrapper>
          {/* flex-1 so the footer sits BELOW the content and is pushed to the
              bottom of the viewport on short pages. It used to be `fixed`, which
              overlaid the bottom of every page — on mobile that covered the
              sign-up / log-in link at the foot of the auth card. In normal flow
              it stays visible without ever blocking anything. */}
          <main className="flex-1">
            <TRPCReactProvider>
              <MatricGate>{children}</MatricGate>
            </TRPCReactProvider>
          </main>
          <footer className="bg-emerald-800 py-4 text-center text-sm text-white">
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
