import { useEffect, useState } from "react";

interface Props {
  isRecording: boolean;
}

export function AudioBars({ isRecording }: Props) {
  const [heights, setHeights] = useState([4, 8, 14, 10, 6]);

  useEffect(() => {
    if (!isRecording) { setHeights([4, 8, 14, 10, 6]); return; }
    const id = setInterval(() => {
      setHeights(Array.from({ length: 5 }, () => 3 + Math.floor(Math.random() * 14)));
    }, 100);
    return () => clearInterval(id);
  }, [isRecording]);

  return (
    <div className="flex items-end gap-[3px] h-[18px]">
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: 3, height: h, borderRadius: 2,
            background: `rgba(var(--accent-rgb), ${isRecording ? 0.65 : 0.35})`,
            transition: "height 0.1s",
          }}
        />
      ))}
    </div>
  );
}
