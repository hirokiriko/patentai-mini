"use client";

import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";

type ToastContextType = {
  show: (message: string) => void;
};

const ToastContext = createContext<ToastContextType>({ show: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; key: number } | null>(
    null,
  );

  const show = useCallback((message: string) => {
    setToast({ message, key: Date.now() });
    setTimeout(() => setToast(null), 3000);
  }, []);

  return (
    <ToastContext value={{ show }}>
      {children}
      {toast && (
        <div
          key={toast.key}
          className="fixed bottom-24 left-1/2 z-[100] -translate-x-1/2 animate-bounce-in rounded-xl border border-blue-200 bg-blue-600 px-6 py-4 text-base font-medium text-white shadow-xl"
        >
          {toast.message}
        </div>
      )}
    </ToastContext>
  );
}
