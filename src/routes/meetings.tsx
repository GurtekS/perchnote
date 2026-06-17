import { createFileRoute } from "@tanstack/react-router";
import { NotesList } from "../components/notes/NotesList";

interface SearchParams {
  /** Exact tag name to filter the list by — written by tag chips on
   *  meeting cards and the meeting page (tags read path). */
  tag?: string;
}

export const Route = createFileRoute("/meetings")({
  component: MeetingsPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    tag: typeof search.tag === "string" ? search.tag : undefined,
  }),
});

function MeetingsPage() {
  const { tag } = Route.useSearch();
  return <NotesList initialTag={tag} />;
}
