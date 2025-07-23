"use client";

import React, { useState } from "react";
import { useSession } from "next-auth/react";
import {
  User,
  Mail,
  MessageCircle,
  Edit3,
  UserIcon,
} from "lucide-react";
import Toast from "../_components/Toast";
import Header from "../_components/header";
import { api } from "~/trpc/react";
import Loading from "../_components/Loading";
import EditProfileModal from "../_components/EditProfileModal";

const ProfilePage: React.FC = () => {
  const { data: session } = useSession();
  const [toastContent, setToastContent] = useState<string>("");
  const [toastType, setToastType] = useState<"success" | "danger">("success");
  const [toastOpen, setToastOpen] = useState<boolean>(false);
  const [openEditProfileModal, setOpenEditProfileModal] =
    useState<boolean>(false);

  const {
    data: user,
    isLoading,
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
      {!isLoading && (
        <EditProfileModal
          isOpen={openEditProfileModal}
          onClose={() => setOpenEditProfileModal(false)}
          initialData={{
            name: user?.displayName ?? "",
            telegramHandle: user?.telegramHandle ?? "",
            bio: user?.bio ?? "",
            block: 8,
          }}
          onSuccess={handleEditSuccess}
        />
      )}

      <Header currentPage="profile" />
      {isLoading ? (
        <div className="mt-40 flex items-center justify-center">
          <Loading />
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
                      <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">
                        {session?.user.name}
                      </h1>
                      <p className="font-medium text-gray-500">
                        {session?.user.userID}
                      </p>
                    </div>
                    <button
                      onClick={() => setOpenEditProfileModal(true)}
                      className="mt-3 inline-flex items-center rounded-lg bg-emerald-600 px-4 py-2 text-white transition-colors hover:bg-emerald-700 sm:mt-0"
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
                  <p className="leading-relaxed text-gray-700">{user?.bio}</p>
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
                      </div>
                    </div>

                    <div className="flex items-center rounded-lg bg-gray-50 p-4">
                      <MessageCircle className="mr-3 h-5 w-5 text-gray-500" />
                      <div>
                        <p className="text-sm text-gray-500">Telegram Handle</p>
                        <p className="font-medium text-gray-900">
                          {user?.telegramHandle}
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
                          {user?.block}
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
