// EditProfileModal.tsx
"use client";

import React, { useState } from "react";
import { api } from "~/trpc/react";

interface EditProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialData: {
    name: string;
    telegramHandle: string;
    bio: string;
    block: number;
  };
  onSuccess: () => void;
}

const EditProfileModal: React.FC<EditProfileModalProps> = ({
  isOpen,
  onClose,
  initialData,
  onSuccess,
}) => {
  const [telegramHandle, setTelegramHandle] = useState<string>(
    initialData.telegramHandle,
  );
  const [bio, setBio] = useState<string>(initialData.bio);
  const [block, setBlock] = useState<number>(initialData.block);
  const [error, setError] = useState<boolean>(false);

  const updateUser = api.user.updateUserData.useMutation({
    onSuccess: () => {
      onSuccess();
      onClose();
    },
  });

  const handleSubmit = () => {
    if (!block) {
      setError(true);
      return;
    }
    updateUser.mutate({
      telegramHandle,
      bio,
      block: block,
    });
    setError(false);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-lg">
        <button
          onClick={onClose}
          className="absolute right-6 top-4 text-2xl text-gray-500 hover:text-gray-700"
        >
          &times;
        </button>
        <h2 className="mb-4 text-2xl font-bold text-gray-800">Edit Profile</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Telegram Handle
            </label>
            <input
              value={telegramHandle}
              onChange={(e) => setTelegramHandle(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Bio
            </label>
            <textarea
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              rows={3}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Block Number
            </label>
            <select
              value={block}
              onChange={(e) => setBlock(parseInt(e.target.value))}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="">Select Block</option>
              {[2, 3, 4, 5, 6, 7, 8].map((num) => (
                <option key={num} value={num.toString()}>
                  {num}
                </option>
              ))}
            </select>
            {error && (
              <p className="mt-1 text-sm text-red-500">Don&apos;t anyhow leh</p>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-x-4">
          <button
            onClick={onClose}
            className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          >
            Close
          </button>
          <button
            onClick={handleSubmit}
            className="rounded-md bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};

export default EditProfileModal;
