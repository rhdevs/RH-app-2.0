import React, { useEffect } from "react";
import ReactDOM from "react-dom";

interface ToastProps {
  content: string;
  type: "success" | "danger";
  show: boolean;
  onClose: () => void;
}

const Toast: React.FC<ToastProps> = ({ content, type, show, onClose }) => {
  useEffect(() => {
    if (show) {
      const timer = setTimeout(() => {
        onClose();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [show, onClose]);

  if (!show) return null;

  return ReactDOM.createPortal(
    <div
      className="z-999 fixed bottom-5 right-5 flex w-full max-w-xs items-center space-x-4 rounded-lg bg-white p-4 text-gray-500 shadow-sm dark:divide-gray-700 dark:bg-gray-800 dark:text-gray-400"
      role="alert"
    >
      <div
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center ${
          type === "success"
            ? "rounded-lg bg-green-100 text-green-500 dark:bg-green-800 dark:text-green-200"
            : "rounded-lg bg-red-100 text-red-500 dark:bg-red-800 dark:text-red-200"
        }`}
      >
        {type === "success" ? (
          <svg
            className="h-5 w-5"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z" />
          </svg>
        ) : (
          <svg
            className="h-5 w-5"
            xmlns="http://www.w3.org/2000/svg"
            fill="currentColor"
            viewBox="0 0 20 20"
          >
            <path d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5ZM10 15a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm1-4a1 1 0 0 1-2 0V6a1 1 0 0 1 2 0v5Z" />
          </svg>
        )}
      </div>
      <div className="ms-3 text-sm font-normal flex-grow">{content}</div>
      <button
        type="button"
        onClick={onClose}
        className="-mx-1.5 -my-1.5 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-900 focus:ring-2 focus:ring-gray-300 dark:bg-gray-800 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-white"
        aria-label="Close"
      >
        <svg
          className="h-3 w-3"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 14 14"
        >
          <path
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="m1 1 6 6m0 0 6 6M7 7l6-6M7 7l-6 6"
          />
        </svg>
      </button>
    </div>,
    document.body,
  );
};

export default Toast;
