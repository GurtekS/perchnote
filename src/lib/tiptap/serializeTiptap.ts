import { formatDeadline } from "./formatDeadline";

/**
 * Canonical TipTap → Markdown serializer (plan v2 rank 5). Copy and export
 * previously used an ad-hoc extractor that only knew paragraph/bulletList/
 * heading — so the AI summary and every action item silently vanished from
 * everything leaving the app. All outbound text goes through here.
 */
export function serializeTiptapToMarkdown(doc: unknown): string {
  const root = doc as { content?: unknown[] } | null;
  if (!root?.content) return "";
  return root.content
    .map((n) => serializeBlock(n as Node, 0))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
  content?: Node[];
}

/** Mirrors SAFE_LINK_SCHEMES + isAllowedUri in extensions.ts — kept local so
 *  this pure module never drags the editor (tippy, React, Tauri) into tests. */
const SAFE_LINK_SCHEMES = ["http", "https", "mailto"];

function safeLinkHref(marks: Node["marks"]): string | null {
  const href = (marks ?? []).find((m) => m.type === "link")?.attrs?.href;
  if (typeof href !== "string") return null;
  try {
    const parsed = new URL(href, "about:blank");
    if (SAFE_LINK_SCHEMES.some((s) => parsed.protocol === `${s}:`)) return href;
  } catch {
    // unparseable href — treat as unsafe
  }
  return null;
}

function inline(nodes: Node[] | undefined): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      // ⌘D chips carry their time in attrs (atom node, no text content).
      if (n.type === "timestampChip") {
        const ms = typeof n.attrs?.ms === "number" ? n.attrs.ms : 0;
        const totalSec = Math.floor(ms / 1000);
        return `⏱ ${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, "0")}`;
      }
      // @-mentions are atoms too — their text lives in attrs (label ?? id,
      // same preference as the editor's renderText in mention.ts).
      if (n.type === "mention") {
        const label = n.attrs?.label ?? n.attrs?.id;
        return label != null && String(label) !== "" ? `@${String(label)}` : "";
      }
      if (n.type !== "text") return inline(n.content);
      let t = n.text ?? "";
      const marks = new Set((n.marks ?? []).map((m) => m.type));
      if (marks.has("code")) t = `\`${t}\``;
      if (marks.has("bold")) t = `**${t}**`;
      if (marks.has("italic")) t = `*${t}*`;
      if (marks.has("strike")) t = `~~${t}~~`;
      // Link wraps last so other marks land inside: [**text**](href).
      // Unsafe schemes (anything outside SAFE_LINK_SCHEMES) fall back to text.
      if (marks.has("link")) {
        const href = safeLinkHref(n.marks);
        if (href) t = `[${t}](${href})`;
      }
      return t;
    })
    .join("");
}

function listItems(node: Node, marker: (i: number) => string, depth: number): string {
  const indent = "  ".repeat(depth);
  return (node.content ?? [])
    .map((li, i) => {
      const parts: string[] = [];
      for (const child of li.content ?? []) {
        if (child.type === "bulletList" || child.type === "orderedList") {
          parts.push(serializeBlock(child, depth + 1));
        } else {
          parts.push(`${indent}${marker(i)}${inline(child.content)}`);
        }
      }
      return parts.join("\n");
    })
    .join("\n");
}

function serializeBlock(node: Node, depth: number): string {
  switch (node.type) {
    case "heading": {
      const level = Math.min(Number(node.attrs?.level ?? 1), 6);
      return `${"#".repeat(level)} ${inline(node.content)}`;
    }
    case "paragraph":
      return inline(node.content);
    case "summary":
      return `> **Summary:** ${inline(node.content)}`;
    case "actionItem": {
      const a = node.attrs ?? {};
      const done = a.done === true;
      const extras: string[] = [];
      if (typeof a.assignee === "string" && a.assignee.trim()) extras.push(`@${a.assignee.trim()}`);
      if (typeof a.deadline === "string" && a.deadline.trim()) extras.push(`due ${formatDeadline(a.deadline) ?? a.deadline}`);
      if (typeof a.source_start_ms === "number") {
        const s = Math.floor(a.source_start_ms / 1000);
        extras.push(`${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`);
      }
      const suffix = extras.length ? ` (${extras.join(", ")})` : "";
      return `- [${done ? "x" : " "}] ${String(a.task ?? "")}${suffix}`;
    }
    case "bulletList":
      return listItems(node, () => "- ", depth);
    case "orderedList":
      return listItems(node, (i) => `${i + 1}. `, depth);
    case "taskList":
      return (node.content ?? [])
        .map((li) => `- [${li.attrs?.checked === true ? "x" : " "}] ${inline(li.content?.[0]?.content)}`)
        .join("\n");
    case "blockquote":
      return (node.content ?? []).map((c) => `> ${serializeBlock(c, depth)}`).join("\n");
    case "codeBlock":
      return "```\n" + inline(node.content) + "\n```";
    case "pastedImage": {
      // Pasted screenshots (plan v9 #13): the attr holds the absolute disk
      // path. The destination is angle-bracketed (QA audit P2-6): the path
      // always contains "Application Support", and a bare space in a
      // CommonMark destination is invalid — it rendered as broken literal
      // text in Obsidian. <…> is the spec's escape for spaces.
      const src = typeof node.attrs?.src === "string" ? node.attrs.src.trim() : "";
      if (!src) return "";
      const alt =
        typeof node.attrs?.alt === "string" && node.attrs.alt.trim()
          ? node.attrs.alt.trim()
          : "pasted image";
      return `![${alt}](<${src}>)`;
    }
    case "horizontalRule":
      return "---";
    default:
      // Unknown nodes degrade to their inline text instead of vanishing.
      return inline(node.content);
  }
}
