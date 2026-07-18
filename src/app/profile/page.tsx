"use client";

import React, { useState } from "react";
import { signOut } from "next-auth/react";
import {
  User,
  Mail,
  MessageCircle,
  Edit3,
  UserIcon,
  Eye,
  EyeOff,
  AlertTriangle,
} from "lucide-react";
import { format } from "date-fns";
import Toast from "../_components/Toast";
import Header from "../_components/header";
import { api } from "~/trpc/react";
import Loading from "../_components/Loading";
import EditProfileModal from "../_components/EditProfileModal";
import { RoleBadges } from "../_components/RoleBadges";

/** Mask a matric as A•••••••X — first and last character only. The matric is an
 *  identity credential, so the default render must not be the full value. */
const maskMatric = (m: string) =>
  m.length <= 2 ? m : `${m[0]}${"•".repeat(m.length - 2)}${m[m.length - 1]}`;

const ProfilePage: React.FC = () => {
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [openEditProfileModal, setOpenEditProfileModal] =
    useState<boolean>(false);
  const [showMatric, setShowMatric] = useState<boolean>(false);

  const {
    data: user,
    isLoading,
    isError,
    error,
    refetch,
  } = api.user.getCurrentUserData.useQuery();

  const handleEditSuccess = async () => {
    await refetch();
    setToastContent("Profile updated successfully");
    setToastType("success");
    setToastOpen(true);
  };

  return (
    <>
      <Toast
        content={toastContent}
        type={toastType}
        show={toastOpen}
        onClose={() => setToastOpen(false)}
      />

      {/* Mounted only while open, so the useState initialisers re-run on every
          open. Without this the modal keeps abandoned edits from a previous
          cancel and presents them as the current profile. The `key` additionally
          remounts it if the underlying profile changes beneath an open modal. */}
      {user && openEditProfileModal && (
        <EditProfileModal
          key={user.id}
          isOpen={openEditProfileModal}
          onClose={() => setOpenEditProfileModal(false)}
          initialData={{
            displayName: user.displayName ?? "",
            telegramHandle: user.telegramHandle ?? "",
            bio: user.bio ?? "",
            // "" — NOT a fabricated `?? 8`, which pre-selected Block 8 for a user
            // who had never chosen one and let them save it by accident.
            block: user.block ?? "",
          }}
          onSuccess={handleEditSuccess}
        />
      )}

      <Header currentPage="profile" />

      {isLoading ? (
        <div className="mt-40 flex items-center justify-center">
          <Loading />
        </div>
      ) : isError ? (
        // Previously a failed query rendered an empty shell forever.
        <div className="mt-40 flex flex-col items-center justify-center gap-4 px-4 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <h1 className="text-xl font-semibold text-gray-900">
            Could not load your profile
          </h1>
          <p className="max-w-md text-sm text-gray-600">
            {error?.message ?? "Something went wrong."}
          </p>
          <button
            onClick={() => void refetch()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          >
            Try again
          </button>
        </div>
      ) : user && !user.eligible ? (
        /* D-7: an empty canonical userID means a pre-cutover session on an
           address that is not @u.nus.edu. This is a POLICY state, not a data
           problem, so it gets its own panel — rendering the ordinary profile
           with an amber "No roles" pill would misdiagnose it, and there is
           deliberately no Edit button or badge row here. */
        <div className="mt-32 flex flex-col items-center justify-center gap-4 px-4 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <h1 className="text-xl font-semibold text-gray-900">
            This account cannot be used to book facilities
          </h1>
          <p className="max-w-md text-sm text-gray-600">
            Raffles Hall accounts must be NUS student accounts
            (<span className="font-medium">@u.nus.edu</span>). You are signed in
            as <span className="font-medium">{user.email}</span>. Please sign out
            and sign in again with your NUS student account, or contact the JCRC
            if you believe this is a mistake.
          </p>
          <button
            onClick={() => void signOut({ callbackUrl: "/login" })}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="mb-14 min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-8 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-4xl">
            <div className="relative px-6 pb-8">
              <div className="flex flex-col sm:flex-row sm:items-end sm:space-x-6">
                <div className="relative">
                  <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-white bg-gray-200 shadow-lg sm:h-32 sm:w-32">
                    <UserIcon className="h-12 w-12 text-gray-500 sm:h-16 sm:w-16" />
                  </div>
                </div>

                <div className="mt-4 flex-1 sm:mt-0">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      {/* Query first, not session.user.name: an edited display
                          name shows immediately here rather than waiting for the
                          session to refresh. */}
                      <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                        {user?.displayName ?? "Unnamed resident"}
                      </h1>
                      <p className="font-mono text-sm font-medium text-gray-500">
                        {user?.userID}
                      </p>
                      {/* Sourced from the QUERY, never session.user.roles: one
                          fetch, one derivation, one place to audit. Badges are
                          not rendered during isLoading — an empty array during
                          load is indistinguishable from genuinely zero roles and
                          would flash the lockout warning on every page view. */}
                      <div className="mt-2">
                        <RoleBadges roles={user?.roles ?? []} />
                      </div>
                    </div>
                    <button
                      onClick={() => setOpenEditProfileModal(true)}
                      className="mt-3 inline-flex items-center self-start rounded-lg bg-emerald-600 px-4 py-2 text-white transition-colors hover:bg-emerald-700 sm:mt-0"
                    >
                      <Edit3 className="mr-2 h-4 w-4" />
                      Edit Profile
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
              <div className="space-y-6 lg:col-span-2">
                <div className="rounded-xl bg-white p-6 shadow-lg">
                  <h2 className="mb-4 flex items-center text-xl font-semibold text-gray-900">
                    <User className="mr-2 h-5 w-5 text-blue-600" />
                    About Me
                  </h2>
                  <p className="leading-relaxed text-gray-700">
                    {user?.bio ? (
                      user.bio
                    ) : (
                      <span className="italic text-gray-400">
                        No bio yet — tell people about yourself.
                      </span>
                    )}
                  </p>
                </div>

                <div className="rounded-xl bg-white p-6 shadow-lg">
                  <h2 className="mb-6 flex items-center text-xl font-semibold text-gray-900">
                    <Mail className="mr-2 h-5 w-5 text-blue-600" />
                    Contact Information
                  </h2>

                  <div className="space-y-4">
                    <div className="flex items-center rounded-lg bg-gray-50 p-4">
                      <Mail className="mr-3 h-5 w-5 text-gray-500" />
                      <div>
                        <p className="text-sm text-gray-500">Email Address</p>
                        <p className="font-medium text-gray-900">
                          {user?.email}
                        </p>
                        {/* Read-only by design: the email is the login identity
                            and the derivation source for the canonical userID,
                            so changing it would silently re-key roles, matric
                            and bookings. */}
                        <p className="text-xs text-gray-400">
                          Cannot be changed
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center rounded-lg bg-gray-50 p-4">
                      <MessageCircle className="mr-3 h-5 w-5 text-gray-500" />
                      <div>
                        <p className="text-sm text-gray-500">Telegram Handle</p>
                        <p className="font-medium text-gray-900">
                          {/* Stored without "@"; rendered with one. */}
                          {user?.telegramHandle
                            ? `@${user.telegramHandle}`
                            : "Not set"}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-6">
                <div className="rounded-xl bg-white p-6 shadow-lg">
                  <h2 className="mb-6 text-xl font-semibold text-gray-900">
                    Info
                  </h2>

                  <div className="space-y-4">
                    <div className="border-b border-gray-100 pb-4">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">Block Number</span>
                        <span className="font-semibold text-gray-900">
                          {user?.block ?? "Not set"}
                        </span>
                      </div>
                    </div>

                    <div className="border-b border-gray-100 pb-4">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-gray-600">Matric</span>
                        <span className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-gray-900">
                            {user?.matric
                              ? showMatric
                                ? user.matric
                                : maskMatric(user.matric)
                              : "Not set"}
                          </span>
                          {user?.matric && (
                            <button
                              type="button"
                              onClick={() => setShowMatric((v) => !v)}
                              aria-label={
                                showMatric
                                  ? "Hide matric number"
                                  : "Show matric number"
                              }
                              className="text-gray-400 hover:text-gray-600"
                            >
                              {showMatric ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </button>
                          )}
                        </span>
                      </div>
                      {/* Set once at onboarding; not self-service in v1. */}
                      <p className="mt-1 text-xs text-gray-400">
                        Wrong matric? Contact the JCRC.
                      </p>
                    </div>

                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-gray-600">Member since</span>
                        <span className="font-semibold text-gray-900">
                          {user?.createdAt
                            ? format(new Date(user.createdAt), "d MMM yyyy")
                            : "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ProfilePage;
