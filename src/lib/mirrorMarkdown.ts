import type { Meeting } from "./ipc";

/**
 * The ONE canonical mirror-document builder (plan v8 B1). Both mirror
 * writers — the post-enhance write in lib/enhance.ts and Data Settings'
 * "Sync all" sweep — had drifted (bare body vs ad-hoc `# title` prefix);
 * every mirrored .md now goes through here and gets Dataview-ready YAML
 * frontmatter: query `type: meeting` or `tags: perchnote` in Obsidian,
 * jump back via the `perchnote:` deep link.
 *
 * The Rust side (write_md_mirror) still owns paths and naming; this module
 * owns the file's contents.
 */
export interface MirrorMeta {
  /** Meeting tag names; `perchnote` is always prepended. */
  tags?: string[];
  /** Folder names the meeting belongs to. */
  folders?: string[];
  /** Diarization speaker labels — never ICS attendees. */
  speakers?: string[];
  /** Absolute path of the local recording, when one exists (plan v8 B7). */
  audio?: string | null;
}

export function buildMirrorMarkdown(
  meeting: Meeting,
  bodyMd: string,
  opts: MirrorMeta = {},
): string {
  const fm: string[] = [];
  fm.push(`title: ${yamlQuote(meeting.title)}`);

  // Same COALESCE the meeting list renders by: when it actually happened,
  // else when it was supposed to, else when the row was created. Date and
  // time come from the same instant in LOCAL time so they never disagree
  // across a midnight-UTC boundary.
  const startIso = meeting.actual_start || meeting.scheduled_start || meeting.created_at;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    const literal = startIso.slice(0, 10);
    if (literal) fm.push(`date: ${literal}`);
  } else {
    fm.push(`date: ${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`);
    // Quoted — a bare HH:MM is YAML 1.1 sexagesimal (14:30 → 870).
    fm.push(`time: "${pad2(start.getHours())}:${pad2(start.getMinutes())}"`);
  }

  const duration =
    spanMinutes(meeting.actual_start, meeting.actual_end) ??
    spanMinutes(meeting.scheduled_start, meeting.scheduled_end);
  if (duration != null) fm.push(`duration_minutes: ${duration}`);

  fm.push("type: meeting");
  if (meeting.platform && meeting.platform !== "unknown") {
    fm.push(`platform: ${yamlScalar(meeting.platform)}`);
  }
  if (meeting.location?.trim()) fm.push(`location: ${yamlQuote(meeting.location.trim())}`);
  // Raw absolute path, not a file:// URL — the most tool-agnostic form for
  // Dataview queries (`WHERE audio`) and shell/Shortcuts automation. The
  // recording stays where it is; nothing is copied into the vault.
  if (opts.audio?.trim()) fm.push(`audio: ${yamlQuote(opts.audio.trim())}`);

  const folders = cleanList(opts.folders);
  if (folders.length) fm.push(`folders: ${yamlFlowList(folders)}`);
  fm.push(`tags: ${yamlFlowList(cleanList(["perchnote", ...(opts.tags ?? [])]))}`);
  const speakers = cleanList(opts.speakers);
  if (speakers.length) fm.push(`speakers: ${yamlFlowList(speakers)}`);

  fm.push(`perchnote: perchnote://meeting/${meeting.id}`);
  fm.push(`id: ${meeting.id}`);

  const parts = [`---\n${fm.join("\n")}\n---`, `# ${meeting.title}`];
  const body = bodyMd.trimEnd();
  if (body) parts.push(body);
  return parts.join("\n\n") + "\n";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Whole minutes between two timestamps of the SAME kind (actual or
 *  scheduled) — mixing an actual start with a scheduled end fabricates
 *  durations. Null when either end is missing, unparseable, or the span
 *  isn't positive. */
function spanMinutes(startIso: string | null, endIso: string | null): number | null {
  if (!startIso || !endIso) return null;
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const mins = Math.round((b - a) / 60000);
  return mins > 0 ? mins : null;
}

/** Trimmed, de-duplicated, no empties — never emit an empty list item. */
function cleanList(items: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items ?? []) {
    const item = raw.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/** Always double-quote (titles, locations): escape \ and ", flatten any
 *  control characters to spaces so one pathological title can't corrupt
 *  the frontmatter block. */
function yamlQuote(value: string): string {
  return `"${value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

/** Conservative plain-scalar shape, valid in both block and flow context:
 *  alphanumeric edges; letters/digits/space/_-./ inside. Everything YAML
 *  could mis-parse (:, #, commas, brackets, quotes, leading dashes…) falls
 *  through to quoting. */
const YAML_PLAIN = /^[A-Za-z0-9](?:[A-Za-z0-9 _./-]*[A-Za-z0-9_./-])?$/;
/** Plain-safe spellings YAML would re-type as bool/null/number. */
const YAML_AMBIGUOUS = /^(?:true|false|yes|no|on|off|null|~|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)$/i;

/** Quote only when YAML would mangle or re-type the value. */
function yamlScalar(value: string): string {
  if (YAML_PLAIN.test(value) && !YAML_AMBIGUOUS.test(value)) return value;
  return yamlQuote(value);
}

/** Inline (flow) sequence: `[a, b, "needs: quoting"]`. */
function yamlFlowList(items: string[]): string {
  return `[${items.map(yamlScalar).join(", ")}]`;
}
