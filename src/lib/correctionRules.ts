import { ipc } from "./ipc";

// Persistent transcript-correction rules (plan v10 #5) — the TS side of
// src-tauri/src/transcription/corrections.rs. Stored as one JSON array in
// the settings k/v under `correction_rules`; applied Rust-side where ASR
// text is born (live chunks, re-transcription, imports).

export interface CorrectionRule {
  find: string;
  replace: string;
}

const KEY = "correction_rules";

export async function loadCorrectionRules(): Promise<CorrectionRule[]> {
  try {
    const stored = await ipc.getSetting(KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is CorrectionRule =>
        typeof r?.find === "string" && typeof r?.replace === "string" && r.find.trim() !== "",
    );
  } catch {
    return [];
  }
}

async function save(rules: CorrectionRule[]): Promise<void> {
  await ipc.setSetting(KEY, JSON.stringify(rules));
}

/** Add (or update) a rule; matching is case-insensitive on `find`, so a
 *  re-add with a different replacement updates rather than duplicates. */
export async function addCorrectionRule(find: string, replace: string): Promise<CorrectionRule[]> {
  const f = find.trim();
  const r = replace.trim();
  if (!f || !r) return loadCorrectionRules();
  const rules = await loadCorrectionRules();
  const existing = rules.findIndex((x) => x.find.toLowerCase() === f.toLowerCase());
  if (existing >= 0) rules[existing] = { find: f, replace: r };
  else rules.push({ find: f, replace: r });
  await save(rules);
  return rules;
}

export async function removeCorrectionRule(find: string): Promise<CorrectionRule[]> {
  const rules = (await loadCorrectionRules()).filter(
    (x) => x.find.toLowerCase() !== find.toLowerCase(),
  );
  await save(rules);
  return rules;
}
