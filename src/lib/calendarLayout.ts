/**
 * Collision layout for day-grid calendar events (the Google/Apple Calendar
 * algorithm): overlapping events form clusters, each cluster divides its
 * column's width evenly, and every event takes the leftmost free track.
 */
export interface LaidOutEvent<T> {
  item: T;
  /** Track index within the cluster (0-based from the left). */
  col: number;
  /** Total tracks in this event's cluster — divide the width by this. */
  cols: number;
}

export function layoutDayEvents<T>(
  events: T[],
  startMinOf: (t: T) => number,
  endMinOf: (t: T) => number,
): LaidOutEvent<T>[] {
  const sorted = [...events].sort((a, b) => {
    const d = startMinOf(a) - startMinOf(b);
    // Longer events first within a tie so they hug the left edge.
    return d !== 0 ? d : endMinOf(b) - endMinOf(a);
  });

  const out: LaidOutEvent<T>[] = [];
  // One open cluster at a time: events chain-connected by overlap. trackEnds
  // holds each track's current end; clusterMaxEnd closes the cluster.
  let cluster: LaidOutEvent<T>[] = [];
  let trackEnds: number[] = [];
  let clusterMaxEnd = -Infinity;

  const closeCluster = () => {
    for (const e of cluster) e.cols = trackEnds.length;
    out.push(...cluster);
    cluster = [];
    trackEnds = [];
    clusterMaxEnd = -Infinity;
  };

  for (const item of sorted) {
    const start = startMinOf(item);
    const end = Math.max(endMinOf(item), start + 1);
    if (cluster.length > 0 && start >= clusterMaxEnd) {
      closeCluster();
    }
    let col = trackEnds.findIndex((trackEnd) => trackEnd <= start);
    if (col === -1) {
      col = trackEnds.length;
      trackEnds.push(end);
    } else {
      trackEnds[col] = end;
    }
    cluster.push({ item, col, cols: 0 });
    clusterMaxEnd = Math.max(clusterMaxEnd, end);
  }
  closeCluster();
  return out;
}
