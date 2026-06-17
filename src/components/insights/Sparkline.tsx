interface Props {
  values: number[];
  /** Screen-reader summary; the bars themselves are decorative. */
  label: string;
  height?: number;
}

/** Tiny inline bar sparkline — the only chart shape /insights uses.
 *  The last (current) bar is accented; everything else is muted. */
export function Sparkline({ values, label, height = 28 }: Props) {
  const max = Math.max(...values, 1);
  const barW = 7;
  const gap = 3;
  const width = values.length * (barW + gap) - gap;
  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label={label}
      className="block"
    >
      {values.map((v, i) => {
        const h = v <= 0 ? 1.5 : Math.max(2, (v / max) * (height - 2));
        return (
          <rect
            key={i}
            x={i * (barW + gap)}
            y={height - h}
            width={barW}
            height={h}
            rx={1.5}
            className={i === values.length - 1 ? "fill-accent" : "fill-text-muted/35"}
          />
        );
      })}
    </svg>
  );
}
