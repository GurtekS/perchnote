import { useEffect, useState } from "react";
import { useToastStore, Toast } from "../../stores/toastStore";
import { X, CheckCircle2, AlertCircle, Info, AlertTriangle } from "lucide-react";

const iconMap = {
  success: <CheckCircle2 size={14} className="text-emerald-400 shrink-0 mt-0.5" />,
  error:   <AlertCircle  size={14} className="text-red-400    shrink-0 mt-0.5" />,
  info:    <Info         size={14} className="text-blue-400   shrink-0 mt-0.5" />,
  warning: <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />,
};

const accentMap = {
  success: "bg-emerald-400",
  error:   "bg-red-400",
  info:    "bg-blue-400",
  warning: "bg-amber-400",
};

function ToastItem({ t, onRemove }: { t: Toast; onRemove: () => void }) {
  const duration = t.duration ?? 4000;
  const [progress, setProgress] = useState(100);
  const [visible, setVisible] = useState(false);

  // Entrance animation
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

  // Progress bar countdown
  useEffect(() => {
    if (duration <= 0) return;
    const interval = 30;
    const steps = duration / interval;
    const decrement = 100 / steps;
    const timer = setInterval(() => {
      setProgress(p => {
        const next = p - decrement;
        if (next <= 0) { clearInterval(timer); return 0; }
        return next;
      });
    }, interval);
    return () => clearInterval(timer);
  }, [duration]);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(onRemove, 200);
  };

  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-white/10 shadow-2xl
        bg-[#1c1c1e] backdrop-blur-xl text-white
        transition-all duration-200 ease-out w-80
        ${visible ? "opacity-100 translate-x-0" : "opacity-0 translate-x-6"}`}
      role="alert"
    >
      {/* Subtle left accent strip */}
      <div className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-full ${accentMap[t.type]} opacity-70`} />

      <div className="px-4 py-3 pl-5">
        <div className="flex items-start gap-2.5">
          {iconMap[t.type]}
          <div className="flex-1 min-w-0">
            {t.title && (
              <p className="text-[12px] font-semibold text-white leading-tight mb-0.5">{t.title}</p>
            )}
            <p className={`text-[12px] leading-snug ${t.title ? "text-white/60" : "text-white/90"}`}>
              {t.message}
            </p>
            {t.action && (
              <button
                onClick={() => { t.action!.onClick(); handleDismiss(); }}
                className="mt-2 text-[11px] font-medium text-white/80 hover:text-white underline underline-offset-2 transition-colors"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            onClick={handleDismiss}
            className="shrink-0 text-white/30 hover:text-white/70 transition-colors mt-0.5"
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Progress bar */}
      {duration > 0 && (
        <div className="h-[2px] bg-white/5">
          <div
            className={`h-full ${accentMap[t.type]} opacity-50 transition-none`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem t={t} onRemove={() => removeToast(t.id)} />
        </div>
      ))}
    </div>
  );
}
