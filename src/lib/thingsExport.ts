// Things hand-off (plan v8 B6): build the things:///json URL that creates
// one to-do per open task in a SINGLE call.
//
// Spec (Cultured Code, "Things URL Scheme" — culturedcode.com/things/support/
// articles/2803573/): the json command is `things:///json?data=<payload>`
// where payload is a URL-encoded JSON array; each entry for a to-do is
// `{ "type": "to-do", "attributes": { title, notes, deadline, when } }`.
// `deadline` must be yyyy-mm-dd, `when` accepts "anytime"/"today"/etc., and
// creating items needs no auth-token (only `update` operations do). The plain
// `add` command can't batch reliably, hence json.

/** The slice of an ActionItem the Things hand-off needs. */
export interface ThingsExportItem {
  task: string;
  meeting_id: string;
  meeting_title: string;
  deadline: string | null;
}

interface ThingsTodo {
  type: "to-do";
  attributes: {
    title: string;
    notes: string;
    when: "anytime";
    deadline?: string;
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One things:///json URL creating every item as a to-do filed in Anytime.
 * Notes carry the meeting title plus a perchnote:// deep link back to it.
 * One-way: Things has no readback API, so completions there never sync here.
 */
export function buildThingsUrl(items: ThingsExportItem[]): string {
  const data: ThingsTodo[] = items.map((i) => {
    const attributes: ThingsTodo["attributes"] = {
      title: i.task || "(untitled task)",
      notes: `From “${i.meeting_title}” in Perchnote\nperchnote://meeting/${i.meeting_id}`,
      when: "anytime",
    };
    // Things rejects payloads with malformed dates — only pass clean yyyy-mm-dd.
    const deadline = i.deadline?.slice(0, 10);
    if (deadline && DATE_RE.test(deadline)) attributes.deadline = deadline;
    return { type: "to-do", attributes };
  });
  return `things:///json?data=${encodeURIComponent(JSON.stringify(data))}`;
}
