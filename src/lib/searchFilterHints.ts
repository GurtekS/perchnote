// Client-side mirror of the Rust search grammar's FILTER detection
// (src-tauri/src/db/searchgrammar.rs) — just enough to show the user which
// filters their query activates. The Rust parser stays authoritative for
// actual matching; this only renders chips, so the two can drift in
// pathological cases without breaking search itself.

export interface FilterChip {
  key: "speaker" | "before" | "after" | "folder";
  value: string;
  /** False when the backend will drop the filter (malformed date). */
  valid: boolean;
}

const KEYS = ["speaker", "before", "after", "folder"] as const;

/** Whitespace-split with double-quote grouping — same shape as the Rust
 *  tokenizer (`folder:"Work stuff"` and bare `"quoted phrase"` group). */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (const c of raw) {
    if (c === '"') {
      inQuotes = !inQuotes;
      cur += c;
    } else if (/\s/.test(c) && !inQuotes) {
      if (cur) tokens.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Exactly YYYY-MM-DD with plausible month/day — the backend's rule. */
function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const month = Number(m[2]);
  const day = Number(m[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/**
 * The filters a query activates, in effective form: later duplicates win
 * (matching the backend), so `speaker:a speaker:b` yields one chip for b.
 */
export function extractFilterChips(query: string): FilterChip[] {
  const effective = new Map<FilterChip["key"], FilterChip>();
  for (const token of tokenize(query)) {
    const lower = token.toLowerCase();
    const key = KEYS.find((k) => lower.startsWith(`${k}:`));
    if (!key) continue;
    const value = token.slice(key.length + 1).replace(/"/g, "");
    if (!value) continue;
    const valid = key === "before" || key === "after" ? isIsoDate(value) : true;
    effective.set(key, { key, value: value.toLowerCase(), valid });
  }
  return [...effective.values()];
}

/** One-line syntax reminder rendered in the palette footer. */
export const FILTER_HINT = 'speaker:name  folder:name  before:/after:YYYY-MM-DD  "exact phrase"  prefix*';
