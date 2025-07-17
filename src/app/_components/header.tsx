"use client";

import React, { useState, useEffect } from "react";
import { Menu, X, ChevronDown, Home, Calendar, Box, User } from "lucide-react";
import Image from "next/image";

const Header = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isFacilitiesOpen, setIsFacilitiesOpen] = useState(false);
  const [currentPath, setCurrentPath] = useState("/");
  const [userEmail, setUserEmail] = useState(null);

  useEffect(() => {
    const path = window.location.hash.replace("#", "") || "/";
    setCurrentPath(path);
  }, []);

  const navLinks = [
    { name: "Home", href: "/", icon: Home },
    { name: "Bookings", href: "/bookings", icon: Calendar },
  ];

  const facilityLinks = [
    { name: "Gym", href: "/facilities/gym" },
    { name: "Study Area", href: "/facilities/study-area" },
    { name: "Common Room", href: "/facilities/common-room" },
  ];

  const handleNavClick = (href: string) => {
    setCurrentPath(href);
    setIsMobileMenuOpen(false);
    setIsFacilitiesOpen(false);
    window.location.hash = href;
  };

  const isActive = (href: string) => currentPath === href;
  const isFacilitiesActive = () => currentPath.startsWith("/facilities");

  // Close mobile menu when clicking outside
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
    <header className="sticky top-0 z-50 bg-gradient-to-r from-emerald-800 to-emerald-900 shadow-lg">
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

          {/* Desktop Navigation */}
          <div className="hidden items-center space-x-1 md:flex">
            {navLinks.map((link) => (
              <button
                key={link.name}
                onClick={() => handleNavClick(link.href)}
                className={`flex items-center space-x-2 rounded-lg px-4 py-2 font-medium transition-all duration-200 ${
                  isActive(link.href)
                    ? "bg-emerald-700 text-white shadow-md"
                    : "text-emerald-100 hover:bg-emerald-700 hover:text-white"
                }`}
              >
                <link.icon size={16} />
                <span>{link.name}</span>
              </button>
            ))}

            {/* Facilities Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsFacilitiesOpen(!isFacilitiesOpen)}
                className={`flex items-center space-x-2 rounded-lg px-4 py-2 font-medium transition-all duration-200 ${
                  isFacilitiesActive()
                    ? "bg-emerald-700 text-white shadow-md"
                    : "text-emerald-100 hover:bg-emerald-700 hover:text-white"
                }`}
              >
                <Box size={16} />
                <span>Facilities</span>
                <ChevronDown
                  size={16}
                  className={`transition-transform duration-200 ${
                    isFacilitiesOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              {isFacilitiesOpen && (
                <div className="absolute left-0 top-full z-50 mt-2 w-48 rounded-lg border border-gray-200 bg-white py-2 shadow-xl">
                  {facilityLinks.map((facility) => (
                    <button
                      key={facility.name}
                      onClick={() => handleNavClick(facility.href)}
                      className={`w-full px-4 py-2 text-left text-sm transition-colors duration-200 ${
                        isActive(facility.href)
                          ? "bg-emerald-50 font-medium text-emerald-700"
                          : "text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {facility.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* User Profile / Login */}
          <div className="hidden items-center space-x-4 md:flex">
            {userEmail ? (
              <div className="flex items-center space-x-3">
                <span className="text-sm text-emerald-100">Welcome back!</span>
                <button
                  onClick={() => handleNavClick("/profile")}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 transition-colors duration-200 hover:bg-emerald-500"
                >
                  <User size={20} className="text-white" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => handleNavClick("/login")}
                className="rounded-lg bg-white px-4 py-2 font-medium text-emerald-800 shadow-sm transition-colors duration-200 hover:bg-emerald-50"
              >
                Log in
              </button>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="rounded-lg p-2 text-emerald-100 transition-colors duration-200 hover:bg-emerald-700 md:hidden"
          >
            {isMobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {/* Mobile Menu */}
        {isMobileMenuOpen && (
          <div className="mobile-menu-container md:hidden">
            <div className="space-y-1 rounded-b-lg bg-emerald-800 px-2 pb-3 pt-2">
              {navLinks.map((link) => (
                <button
                  key={link.name}
                  onClick={() => handleNavClick(link.href)}
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

              {/* Mobile Facilities */}
              <div className="space-y-1">
                <button
                  onClick={() => setIsFacilitiesOpen(!isFacilitiesOpen)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left font-medium transition-colors duration-200 ${
                    isFacilitiesActive()
                      ? "bg-emerald-700 text-white"
                      : "text-emerald-100 hover:bg-emerald-700 hover:text-white"
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <Box size={18} />
                    <span>Facilities</span>
                  </div>
                  <ChevronDown
                    size={16}
                    className={`transition-transform duration-200 ${
                      isFacilitiesOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isFacilitiesOpen && (
                  <div className="ml-6 space-y-1">
                    {facilityLinks.map((facility) => (
                      <button
                        key={facility.name}
                        onClick={() => handleNavClick(facility.href)}
                        className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors duration-200 ${
                          isActive(facility.href)
                            ? "bg-emerald-600 text-white"
                            : "text-emerald-200 hover:bg-emerald-700 hover:text-white"
                        }`}
                      >
                        {facility.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Mobile Login */}
              <div className="border-t border-emerald-700 pt-4">
                {userEmail ? (
                  <button
                    onClick={() => handleNavClick("/profile")}
                    className="flex w-full items-center space-x-3 rounded-lg px-3 py-2 text-left font-medium text-emerald-100 transition-colors duration-200 hover:bg-emerald-700 hover:text-white"
                  >
                    <User size={18} />
                    <span>Profile</span>
                  </button>
                ) : (
                  <button
                    onClick={() => handleNavClick("/login")}
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
