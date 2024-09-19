"use client";

import * as React from "react";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogOverlay,
} from "~/components/ui/dialog";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "~/components/ui/popover";
import {
  HamburgerMenuIcon,
  ChevronDownIcon,
  PieChartIcon,
  CursorArrowIcon,
  QuestionMarkCircledIcon,
} from "@radix-ui/react-icons";

const navLinks = [
  {
    name: "Introduction",
    description: "Raffles Hall is a student-run hall in NUS.",
    href: "#",
    icon: PieChartIcon,
  },
  {
    name: "Facilities",
    description: "See the facilities available in Raffles Hall.",
    href: "/facilities",
    icon: CursorArrowIcon,
  },
  {
    name: "Your bookings",
    description: "See your bookings in Raffles Hall.",
    href: "/bookings",
    icon: CursorArrowIcon,
  },
];

const facilityLinks = [
  { name: "Gym", href: "/facilities/gym" },
  { name: "Study Area", href: "/facilities/study-area" },
  { name: "Common Room", href: "/facilities/common-room" },
];

const Logo = () => (
  <a href="#" className="-m-1.5 p-1.5">
    <span className="sr-only">Your Company</span>
    <img
      className="h-8 w-auto"
      src="https://tailwindui.com/img/logos/mark.svg?color=indigo&shade=600"
      alt="Company Logo"
    />
  </a>
);

const MobileMenuButton = ({ onClick }: { onClick: () => void }) => (
  <button
    type="button"
    className="-m-2.5 inline-flex items-center justify-center rounded-md p-2.5 text-gray-700"
    onClick={onClick}
  >
    <span className="sr-only">Open main menu</span>
    <HamburgerMenuIcon className="h-6 w-6" aria-hidden="true" />
  </button>
);

const DesktopNav = () => (
  <div className="hidden lg:flex lg:gap-x-12">
    <Popover>
      <PopoverTrigger className="flex items-center gap-x-1 text-sm font-semibold leading-6 text-gray-900">
        Facilities
        <ChevronDownIcon
          className="h-5 w-5 flex-none text-gray-400"
          aria-hidden="true"
        />
      </PopoverTrigger>
      <PopoverContent className="absolute -left-8 top-full z-10 mt-3 w-40 rounded-3xl bg-white p-4 shadow-lg ring-1 ring-gray-900/5">
        {facilityLinks.map((item) => (
          <a
            key={item.name}
            href={item.href}
            className="block text-sm font-semibold leading-6 text-gray-900 hover:bg-gray-50"
          >
            {item.name}
          </a>
        ))}
      </PopoverContent>
    </Popover>

    {navLinks.map((item) => (
      <a
        key={item.name}
        href={item.href}
        className="text-sm font-semibold leading-6 text-gray-900"
      >
        {item.name}
      </a>
    ))}
  </div>
);

const MobileMenu = ({
  mobileMenuOpen,
  setMobileMenuOpen,
}: {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean) => void;
}) => (
  <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
    <DialogContent className="sm:max-w-[425px]">
      <div className="flex items-center justify-between">
        <Logo />
        <DialogClose className="-m-2.5 rounded-md p-2.5 text-gray-700">
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
                <div className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-gray-50 group-hover:bg-white">
                  <item.icon
                    className="h-6 w-6 text-gray-600 group-hover:text-indigo-600"
                    aria-hidden="true"
                  />
                </div>
                {item.name}
              </a>
            ))}
          </div>
          <div className="py-6">
            <a
              href="#"
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

export default function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="bg-white">
      <nav
        className="mx-auto flex max-w-7xl items-center justify-between p-6 lg:px-8"
        aria-label="Global"
      >
        <div className="flex lg:flex-1">
          <Logo />
        </div>
        <div className="flex lg:hidden">
          <MobileMenuButton onClick={() => setMobileMenuOpen(true)} />
        </div>
        <DesktopNav />
        <div className="hidden lg:flex lg:flex-1 lg:justify-end">
          <a href="#" className="text-sm font-semibold leading-6 text-gray-900">
            Log in <span aria-hidden="true">&rarr;</span>
          </a>
        </div>
      </nav>
      <MobileMenu
        mobileMenuOpen={mobileMenuOpen}
        setMobileMenuOpen={setMobileMenuOpen}
      />
    </header>
  );
}
