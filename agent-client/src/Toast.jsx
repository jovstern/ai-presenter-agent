import { createContext, useCallback, useContext, useState } from "react";
import * as RadixToast from "@radix-ui/react-toast";

const ToastContext = createContext(null);

/**
 * One-toast-at-a-time notifier, backed by Radix's Toast primitive (accessible, handles the
 * swipe-to-dismiss/auto-dismiss behavior for us). Used both for knowledge-modal feedback
 * (file added/rejected) and — closing v1's silent-disconnect gap for real — the connection
 * status in AgentApp.jsx.
 */
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const [open, setOpen] = useState(false);

  const notify = useCallback((message) => {
    setToast({ id: crypto.randomUUID(), message });
    setOpen(true);
  }, []);

  return (
    <ToastContext.Provider value={notify}>
      <RadixToast.Provider swipeDirection="right" duration={3500}>
        {children}
        <RadixToast.Root className="ds-toast" open={open} onOpenChange={setOpen} key={toast?.id}>
          <RadixToast.Description className="ds-toast-description">
            {toast?.message}
          </RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport className="ds-toast-viewport" hotkey={[]} />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast must be used inside a ToastProvider");
  return notify;
}
