import { useEffect, useRef, useState } from "react";

interface EnhanceAnimationOverlayProps {
  text: string;
  onComplete: () => void;
}

/**
 * Animated overlay that reveals the AI-enhanced markdown text line by line,
 * then calls onComplete when done.
 */
export function EnhanceAnimationOverlay({ text, onComplete }: EnhanceAnimationOverlayProps) {
  const [visibleCount, setVisibleCount] = useState(0);
  const [done, setDone] = useState(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Split raw markdown into non-empty lines
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  useEffect(() => {
    if (lines.length === 0) {
      const t = setTimeout(() => onCompleteRef.current(), 400);
      return () => clearTimeout(t);
    }

    let count = 0;
    const interval = setInterval(() => {
      count++;
      setVisibleCount(count);
      if (count >= lines.length) {
        clearInterval(interval);
        // Wait a moment then fade out
        setTimeout(() => {
          setDone(true);
          setTimeout(() => onCompleteRef.current(), 400);
        }, 400);
      }
    }, 80);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`absolute inset-0 overflow-y-auto px-0 py-4 transition-opacity duration-[400ms] ${
        done ? "opacity-0" : "opacity-100"
      }`}
      style={{ pointerEvents: "none" }}
    >
      <div className="space-y-1.5">
        {lines.slice(0, visibleCount).map((line, i) => {
          const isLast = i === visibleCount - 1 && !done;
          const isHeading = /^#{1,3}\s/.test(line);
          const isBullet = /^[-*]\s/.test(line);

          return (
            <div
              key={i}
              className="enhance-line"
              style={{ animationDelay: "0ms" }}
            >
              {isHeading ? (
                <p className={`font-semibold text-text-primary ${line.startsWith("# ") ? "text-base mt-3" : "text-sm mt-2"}`}>
                  {line.replace(/^#{1,3}\s+/, "")}
                  {isLast && <span className="enhance-cursor" />}
                </p>
              ) : isBullet ? (
                <p className="text-sm text-text-secondary pl-4 leading-relaxed">
                  {"• "}
                  {line.replace(/^[-*]\s+/, "")}
                  {isLast && <span className="enhance-cursor" />}
                </p>
              ) : (
                <p className="text-sm text-text-secondary leading-relaxed">
                  {line}
                  {isLast && <span className="enhance-cursor" />}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
