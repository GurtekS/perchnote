import { describe, expect, it } from "vitest";
import { sanitizeTiptapDoc } from "../../lib/tiptap/sanitizeTiptapDoc";

const docWithLink = (href: string) => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "click", marks: [{ type: "link", attrs: { href } }] },
      ],
    },
  ],
});

const firstMarks = (doc: ReturnType<typeof docWithLink>) =>
  doc.content[0].content[0].marks;

describe("sanitizeTiptapDoc", () => {
  it("keeps http/https/mailto links", () => {
    for (const href of ["https://example.com", "http://example.com", "mailto:a@b.c"]) {
      expect(firstMarks(sanitizeTiptapDoc(docWithLink(href)))).toHaveLength(1);
    }
  });

  it("strips javascript:, file:, and data: links", () => {
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      expect(firstMarks(sanitizeTiptapDoc(docWithLink(href)))).toHaveLength(0);
    }
  });

  it("strips link marks with missing or non-string hrefs", () => {
    const doc = docWithLink("https://ok.example");
    (doc.content[0].content[0].marks[0].attrs as Record<string, unknown>).href = { evil: true };
    expect(firstMarks(sanitizeTiptapDoc(doc))).toHaveLength(0);
  });

  it("preserves non-link marks and nested structure", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "bold",
                      marks: [{ type: "bold" }, { type: "link", attrs: { href: "javascript:x" } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = sanitizeTiptapDoc(doc);
    const marks = out.content[0].content[0].content[0].content[0].marks;
    expect(marks).toEqual([{ type: "bold" }]);
  });
});
