import "~/styles/globals.css";

import { GeistSans } from "geist/font/sans";
import { type Metadata } from "next";

import { TRPCReactProvider } from "~/trpc/react";
import Header from "@/app/_components/header";

export const metadata: Metadata = {
  title: "RH App 2.0",
  description: "RHdev Testing",
  icons: [{ rel: "icon", url: "/raffles-hall-logo.svg" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable}`}>
      <body>
        <Header />
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
