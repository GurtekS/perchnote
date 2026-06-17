const SAFE_LINK_PROTOCOLS = ["http:", "https:", "mailto:"];

/**
 * Strip link marks with unsafe protocols (javascript:, file:, data:, …) from a
 * TipTap JSON doc. Doc JSON reaches the editor from untrusted sources — AI
 * responses, imports — and a link mark is the one place it can smuggle a
 * clickable scheme past the Link extension, whose validation runs on user
 * edits, not on documents loaded via setContent. Mutates and returns the doc.
 */
export function sanitizeTiptapDoc<T>(doc: T): T {
  if (doc && typeof doc === "object") {
    walk(doc as Record<string, unknown>);
  }
  return doc;
}

function walk(node: Record<string, unknown>) {
  const marks = node.marks;
  if (Array.isArray(marks)) {
    node.marks = marks.filter((mark: { type?: string; attrs?: { href?: unknown } }) => {
      if (mark?.type !== "link") return true;
      const href = mark.attrs?.href;
      if (typeof href !== "string") return false;
      try {
        // Relative hrefs resolve against the dummy base and stay https.
        return SAFE_LINK_PROTOCOLS.includes(new URL(href, "https://local.invalid").protocol);
      } catch {
        return false;
      }
    });
  }
  const content = node.content;
  if (Array.isArray(content)) {
    for (const child of content) {
      if (child && typeof child === "object") walk(child as Record<string, unknown>);
    }
  }
}
