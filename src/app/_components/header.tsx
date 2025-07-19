"use client";

import React, { useState, useEffect } from "react";
import { Menu, X, ChevronDown, Home, Calendar, Box, User } from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { signOut } from "next-auth/react";

interface HeaderProps {
  currentPage: string;
}

const Header: React.FC<HeaderProps> = ({ currentPage }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const router = useRouter();
  const { data: session } = useSession();
  const navLinks = [
    { name: "Home", href: "/", icon: Home },
    { name: "Bookings", href: "/bookings", icon: Calendar },
    { name: "Facilities", href: "/facilities", icon: Box },
  ];

  const isActive = (page: string) => {
    if (currentPage === page) return true;
    return false;
  };

  useEffect(() => {
    const handleClickOutside = (event: any) => {
      if (isMobileMenuOpen && !event.target.closest(".mobile-menu-container")) {
        setIsMobileMenuOpen(false);
      }
    };

    document.addEventListener("click", handleClickOutside);
    return () => document.removeEventListener("click", handleClickOutside);
  }, [isMobileMenuOpen]);

  return (
    <header className="sticky top-0 z-50 bg-emerald-800 shadow-lg">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-white">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-600">
                <Image
                  src="/raffles-hall-logo.svg"
                  alt="Raffles Hall Logo"
                  width={50}
                  height={50}
                />
              </div>
            </div>
            <div className="text-white">
              <h1 className="text-xl font-bold">RHApp</h1>
              <p className="text-xs text-emerald-200">
                by Raffles Hall Developers
              </p>
            </div>
          </div>

          <div className="hidden items-center space-x-1 md:flex">
            {navLinks.map((link) => (
              <button
                key={link.name}
                onClick={() => {
                  router.push(link.href);
                }}
                className={`flex items-center space-x-2 rounded-lg px-4 py-2 font-medium transition-all duration-200 ${
                  isActive(link.name)
                    ? "bg-emerald-700 text-white shadow-md"
                    : "text-emerald-100 hover:bg-emerald-700 hover:text-white"
                }`}
              >
                <link.icon size={16} />
                <span>{link.name}</span>
              </button>
            ))}
          </div>

          <div className="hidden items-center space-x-4 md:flex">
            {session ? (
              <div className="flex items-center space-x-3">
                <span className="text-sm text-emerald-100">Welcome back!</span>
                <button
                  onClick={() => {signOut()}}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 transition-colors duration-200 hover:bg-emerald-500"
                >
                  <User size={20} className="text-white" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  router.push("/login");
                }}
                className="rounded-lg bg-white px-4 py-2 font-medium text-emerald-800 shadow-sm transition-colors duration-200 hover:bg-emerald-50"
              >
                Log in
              </button>
            )}
          </div>

          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="rounded-lg p-2 text-emerald-100 transition-colors duration-200 hover:bg-emerald-700 md:hidden"
          >
            {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {isMobileMenuOpen && (
          <div className="mobile-menu-container bg- md:hidden">
            <div className="space-y-1 rounded-b-lg bg-emerald-800 px-2 pb-3 pt-2">
              {navLinks.map((link) => (
                <button
                  key={link.name}
                  onClick={() => {
                    router.push(link.href);
                  }}
                  className={`flex w-full items-center space-x-3 rounded-lg px-3 py-2 text-left font-medium transition-colors duration-200 ${
                    isActive(link.href)
                      ? "bg-emerald-700 text-white"
                      : "text-emerald-100 hover:bg-emerald-700 hover:text-white"
                  }`}
                >
                  <link.icon size={18} />
                  <span>{link.name}</span>
                </button>
              ))}

              <div className="border-t border-emerald-700 pt-4">
                {session ? (
                  <button
                    onClick={() => {}}
                    className="flex w-full items-center space-x-3 rounded-lg px-3 py-2 text-left font-medium text-emerald-100 transition-colors duration-200 hover:bg-emerald-700 hover:text-white"
                  >
                    <User size={18} />
                    <span>Profile</span>
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      router.push("/login");
                    }}
                    className="w-full rounded-lg bg-white px-3 py-2 font-medium text-emerald-800 transition-colors duration-200 hover:bg-emerald-50"
                  >
                    Log in
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
};

export default Header;
