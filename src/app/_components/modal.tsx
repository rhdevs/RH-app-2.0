import React from "react";

interface ModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  onClose: () => void;
}

const Modal: React.FC<ModalProps> = ({ isOpen, title, message, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="absolute bottom-4 right-4 w-full max-w-sm rounded-xl bg-white p-6">
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-2xl text-gray-500 hover:text-gray-700"
        >
          &times;
        </button>

        <h2 className="mb-2 text-2xl font-bold">{title}</h2>
        <p className="mb-4 text-gray-600">{message}</p>
      </div>
    </div>
  );
};

export default Modal;
