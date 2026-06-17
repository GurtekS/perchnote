import { describe, expect, it } from "vitest";
import { buildThingsUrl, ThingsExportItem } from "../../lib/thingsExport";

const PREFIX = "things:///json?data=";

function item(over: Partial<ThingsExportItem> = {}): ThingsExportItem {
  return {
    task: "Send recap",
    meeting_id: "m-123",
    meeting_title: "Weekly sync",
    deadline: null,
    ...over,
  };
}

/** Decode the data param back into the JSON array Things would receive. */
function decodePayload(url: string): Array<{ type: string; attributes: Record<string, string> }> {
  expect(url.startsWith(PREFIX)).toBe(true);
  return JSON.parse(decodeURIComponent(url.slice(PREFIX.length)));
}

describe("buildThingsUrl", () => {
  it("builds one to-do per item via the json command, filed in Anytime", () => {
    const url = buildThingsUrl([item(), item({ task: "Book room", meeting_id: "m-456" })]);
    const payload = decodePayload(url);

    expect(payload).toHaveLength(2);
    for (const entry of payload) {
      expect(entry.type).toBe("to-do");
      expect(entry.attributes.when).toBe("anytime");
    }
    expect(payload[0].attributes.title).toBe("Send recap");
    expect(payload[1].attributes.title).toBe("Book room");
  });

  it("notes carry the meeting title and a perchnote:// deep link", () => {
    const url = buildThingsUrl([item({ meeting_id: "0a3f-uuid", meeting_title: "Q2 Roadmap" })]);
    const [todo] = decodePayload(url);

    expect(todo.attributes.notes).toContain("Q2 Roadmap");
    expect(todo.attributes.notes).toContain("perchnote://meeting/0a3f-uuid");
  });

  it("includes deadline as yyyy-mm-dd when present, omits it when null", () => {
    const url = buildThingsUrl([
      item({ deadline: "2026-06-12" }),
      item({ task: "No date", deadline: null }),
    ]);
    const [withDate, without] = decodePayload(url);

    expect(withDate.attributes.deadline).toBe("2026-06-12");
    expect("deadline" in without.attributes).toBe(false);
  });

  it("trims datetime deadlines to the date and drops malformed ones", () => {
    const url = buildThingsUrl([
      item({ deadline: "2026-06-12T09:30:00Z" }),
      item({ task: "Vague", deadline: "next week" }),
    ]);
    const [sliced, vague] = decodePayload(url);

    expect(sliced.attributes.deadline).toBe("2026-06-12");
    expect("deadline" in vague.attributes).toBe(false);
  });

  it("URL-encodes the payload so reserved characters survive the round-trip", () => {
    const tricky = 'Email Q&A doc = "v2" #final & follow up?';
    const url = buildThingsUrl([item({ task: tricky, meeting_title: "Görüşme — ünïcode" })]);

    // Nothing after the prefix may break URL parsing: one opaque data param.
    const raw = url.slice(PREFIX.length);
    expect(raw).not.toMatch(/[&#"\s]/);

    const [todo] = decodePayload(url);
    expect(todo.attributes.title).toBe(tricky);
    expect(todo.attributes.notes).toContain("Görüşme — ünïcode");
  });

  it("falls back to a placeholder title for untitled tasks", () => {
    const url = buildThingsUrl([item({ task: "" })]);
    expect(decodePayload(url)[0].attributes.title).toBe("(untitled task)");
  });
});
