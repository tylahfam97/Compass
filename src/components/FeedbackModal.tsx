import { useState } from "react";
import { motion } from "motion/react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import { toast, useToastStore } from "@/stores/toastStore";
import { MAX_BODY_BYTES, MAX_MESSAGE, buildFeedbackBody, sendFeedback } from "@/lib/feedback";

interface Props {
  onClose: () => void;
  version: string;
}

export default function FeedbackModal({ onClose, version }: Props) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [errorToast, setErrorToast] = useState<number | null>(null);
  // No dismissing mid-send: a failure after closing would lose the typed text.
  const { onBackdropClick, containerRef } = useModalDismiss(sending ? () => {} : onClose);
  const input = { message, email, version, os: navigator.platform };
  const tooLong = buildFeedbackBody(input).toString().length > MAX_BODY_BYTES;

  async function handleSend() {
    if (errorToast !== null) useToastStore.getState().dismiss(errorToast);
    setSending(true);
    try {
      await sendFeedback(input);
      toast.success("Thanks, sent.");
      onClose();
    } catch {
      // Keep the text so nothing typed is lost; the user can retry.
      setErrorToast(toast.error("Couldn't send. Check your connection or try again later."));
      setSending(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      onClick={onBackdropClick} ref={containerRef}
      role="dialog" aria-modal="true" aria-label="Send feedback"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.15 }}
        className="bg-[hsl(var(--background))] border rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6 m-4"
      >
        <h2 className="text-lg font-semibold mb-4">Send feedback</h2>
        <div className="space-y-4">
          <div>
            <label htmlFor="feedback-message" className="text-xs font-medium text-[hsl(var(--muted-foreground))]">Message</label>
            <textarea
              id="feedback-message"
              value={message} onChange={(e) => setMessage(e.target.value)}
              maxLength={MAX_MESSAGE} rows={6}
              placeholder="What's working, what isn't, what you'd like to see"
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))] resize-y"
            />
            <p className="text-right text-[10px] text-[hsl(var(--muted-foreground))]">
              {tooLong ? <span className="text-[hsl(var(--error))]">Too long to send. Please shorten it.</span> : `${message.length}/${MAX_MESSAGE}`}
            </p>
          </div>
          <div>
            <label htmlFor="feedback-email" className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
              Email, if you'd like a reply (optional)
            </label>
            <input
              id="feedback-email" type="email" maxLength={254}
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm bg-[hsl(var(--background))]"
            />
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            Sends only this message, the email above if you add one, your Compass version and your OS type.
            None of your financial data leaves this device.
          </p>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} disabled={sending} className="px-4 py-2 border rounded-lg text-sm disabled:opacity-50">
            Cancel
          </button>
          <button
            onClick={handleSend} disabled={sending || !message.trim() || tooLong}
            className="px-4 py-2 bg-[hsl(var(--primary))] text-[hsl(var(--primary-foreground))] rounded-lg text-sm disabled:opacity-50"
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
