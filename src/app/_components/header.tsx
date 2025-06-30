"use client";
import * as React from "react";
import { useState, useEffect } from "react";
import Image from "next/image";
import rafflesHallLogo from "/public/raffles-hall-logo.svg";
import { Dialog, DialogContent, DialogClose } from "@/components/ui/dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import {
  HamburgerMenuIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CalendarIcon,
  BoxIcon,
  HomeIcon,
} from "@radix-ui/react-icons";
import { useSession, signIn } from "next-auth/react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  {
    name: "Introduction",
    description: "Raffles Hall is a student-run hall in NUS.",
    href: "/",
    icon: HomeIcon,
  },
  {
    name: "Your Bookings",
    description: "See your bookings in Raffles Hall.",
    href: "/bookings",
    icon: CalendarIcon,
  },
];

const facilityLinks = [
  { name: "Gym", href: "/facilities/gym" },
  { name: "Study Area", href: "/facilities/study-area" },
  { name: "Common Room", href: "/facilities/common-room" },
];

const Logo = () => (
  <a
    href="#"
    className="flex items-center justify-center rounded-lg border-2 border-[#5b5754] bg-white py-2 text-[#44403c]"
  >
    <span className="sr-only">Raffles Hall</span>
    <Image
      src={rafflesHallLogo}
      alt="Raffles Hall Logo"
      width={100}
      className="object-contain"
    />
    <div className="mr-6 text-4xl italic">RHApp</div>
  </a>
);

const MobileMenuButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    className="-m-2.5 inline-flex items-center justify-center rounded-md p-2.5 text-white hover:bg-gray-200"
    onClick={onClick}
  >
    <span className="sr-only">Open main menu</span>
    <HamburgerMenuIcon className="h-6 w-6" aria-hidden="true" />
  </button>
);

const DesktopNav = () => {
  const pathname = usePathname();

  return (
    <div className="relative inline-block">
      {/* 2) The rectangular box around all links */}
      <div className="flex gap-1 rounded-lg border-2 border-[#5b5754] bg-white p-1">
        {navLinks.map((item) => {
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`px-5 py-2 text-center font-semibold leading-6 ${
                isActive
                  ? "rounded-[4px] bg-[#e7e5e4] text-[#44403c]"
                  : "text-[#44403c] hover:text-[#98928e]"
              } `}
            >
              {item.name}
            </Link>
          );
        })}

        {/* 3) The “Facilities” popover trigger */}
        <Popover>
          {/**
           * We mark "Facilities" as active whenever the path begins with /facilities.
           * (So /facilities/gym, /facilities/study-area, etc. all highlight the trigger.)
           */}
          <PopoverTrigger
            className={`flex items-center justify-center px-5 py-2 text-center font-semibold leading-6 ${
              pathname.startsWith("/facilities")
                ? "rounded-[4px] bg-[#e7e5e4] text-[#44403c]"
                : "text-[#44403c] hover:text-[#98928e]"
            } `}
          >
            Facilities
          </PopoverTrigger>

          <PopoverContent className="absolute -left-4 z-10 mt-2 w-56 rounded-lg border-2 border-[#5b5754] bg-white p-1 font-semibold shadow-lg">
            <ul className="space-y-2">
              {facilityLinks.map((fac) => {
                const isFacActive = pathname === fac.href;

                return (
                  <li key={fac.name}>
                    <Link
                      href={fac.href}
                      className={`block px-4 py-2 text-sm font-semibold ${
                        isFacActive
                          ? "rounded-[4px] bg-[#e7e5e4] text-[#44403c]"
                          : "text-[#44403c] hover:bg-[#f5f5f4] hover:text-[#98928e]"
                      } `}
                    >
                      {fac.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};

const MobileMenu = ({
  mobileMenuOpen,
  setMobileMenuOpen,
}: {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}) => {
  const [isFacilitiesDropdownOpen, setFacilitiesDropdownOpen] = useState(false);

  const toggleFacilitiesDropdown = () => {
    setFacilitiesDropdownOpen(!isFacilitiesDropdownOpen);
  };

  return (
    <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
      <DialogContent className="bg-white sm:max-w-[425px]">
        <div className="flex items-center justify-between">
          <Logo />
          <DialogClose className="-m-2.5 rounded-md p-2.5 text-gray-700 hover:bg-gray-200">
            <span className="sr-only">Close menu</span>
          </DialogClose>
        </div>
        <div className="mt-4 flow-root">
          <div className="-my-6 divide-y divide-gray-500/10">
            <div className="space-y-2 py-6">
              {navLinks.map((item) => (
                <a
                  key={item.name}
                  href={item.href}
                  className="group flex items-center gap-x-4 rounded-lg p-3 text-base font-semibold leading-6 text-gray-900 hover:bg-gray-50"
                >
                  <div className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-gray-50 group-hover:bg-indigo-600">
                    <item.icon
                      className="h-6 w-6 text-gray-600 group-hover:text-white"
                      aria-hidden="true"
                    />
                  </div>
                  {item.name}
                </a>
              ))}

              {/* Facilities Toggle */}
              <button
                onClick={toggleFacilitiesDropdown}
                className="group flex w-full items-center gap-x-4 rounded-lg p-3 text-base font-semibold leading-6 text-gray-900 hover:bg-gray-50"
              >
                <div className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-gray-50 group-hover:bg-indigo-600">
                  <BoxIcon
                    className="h-6 w-6 text-gray-600 group-hover:text-white"
                    aria-hidden="true"
                  />
                </div>
                Facilities
                {isFacilitiesDropdownOpen ? (
                  <ChevronUpIcon className="ml-auto h-5 w-5 text-gray-500" />
                ) : (
                  <ChevronDownIcon className="ml-auto h-5 w-5 text-gray-500" />
                )}
              </button>

              {/* Conditional Rendering for Facilities Links */}
              {isFacilitiesDropdownOpen && (
                <div className="ml-8 space-y-2">
                  {facilityLinks.map((facility) => (
                    <a
                      key={facility.name}
                      href={facility.href}
                      className="block rounded-lg px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
                    >
                      {facility.name}
                    </a>
                  ))}
                </div>
              )}
            </div>

            {/* Login Link */}
            <div className="py-6">
              <a
                href="/login"
                className="block rounded-lg px-3 py-2.5 text-base font-semibold leading-6 text-gray-900 hover:bg-gray-50"
              >
                Log in
              </a>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // const { data: session } = useSession() as {
  //   data: { user: { name: string } };
  // };
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    const email = localStorage.getItem("userEmail");
    if (email) setUserEmail(email);
  }, []);
  const pathname = usePathname();

  if (["/login", "/signup"].includes(pathname)) return null;

  return (
    <header className="h-35 bg-[#064e3b] shadow-md">
      <nav
        className="flex h-full translate-y-[20px] transform items-end justify-around lg:px-8"
        aria-label="Global"
      >
        <div className="flex">
          <Logo />
        </div>
        <div className="flex lg:hidden">
          <MobileMenuButton onClick={() => setMobileMenuOpen(true)} />
        </div>
        <DesktopNav />
        <div>
          {userEmail ? (
            <a
              href="/profile"
              className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-300 bg-cover"
              style={{
                backgroundImage: 'url("blank-profile-picture.png")',
                scale: 1,
              }}
            ></a>
          ) : (
            <a
              href="/login"
              className="rounded-lg border-2 border-[#5b5754] bg-white px-5 py-2 font-semibold text-[#44403c] hover:text-[#98928e]"
            >
              Log in <span aria-hidden="true">&rarr;</span>
            </a>
          )}
        </div>
      </nav>

      <MobileMenu
        mobileMenuOpen={mobileMenuOpen}
        setMobileMenuOpen={setMobileMenuOpen}
      />
    </header>
  );
}
