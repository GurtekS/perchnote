import { createFileRoute } from "@tanstack/react-router";
import { NotesList } from "../components/notes/NotesList";

interface SearchParams {
  folder?: string;
}

export const Route = createFileRoute("/meetings")({
  component: MeetingsPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    folder: search.folder as string | undefined,
  }),
});

function MeetingsPage() {
  const { folder } = Route.useSearch();
  return <NotesList initialFolder={folder} />;
}
