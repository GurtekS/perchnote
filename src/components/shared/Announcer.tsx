import { useEffect, useRef } from "react";
import { setAnnounceSink } from "../../lib/announce";

/**
 * The app's two screen-reader live regions, mounted once at the root and
 * kept empty until something speaks. Errors/warnings interrupt (assertive);
 * everything else waits its turn (polite).
 */
export function Announcer() {
  const politeRef = useRef<HTMLDivElement>(null);
  const assertiveRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: number | undefined;
    setAnnounceSink((message, politeness) => {
      const el = politeness === "assertive" ? assertiveRef.current : politeRef.current;
      if (!el) return;
      // Clear-then-set so repeating the same text re-announces.
      el.textContent = "";
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.textContent = message;
      }, 30);
    });
    return () => {
      window.clearTimeout(timer);
      setAnnounceSink(null);
    };
  }, []);

  return (
    <div className="sr-only">
      <div ref={politeRef} role="status" aria-live="polite" aria-atomic="true" />
      <div ref={assertiveRef} role="alert" aria-live="assertive" aria-atomic="true" />
    </div>
  );
}
