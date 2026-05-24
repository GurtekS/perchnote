import { createFileRoute } from "@tanstack/react-router";
import { MeetingView } from "../components/meeting/MeetingView";

export const Route = createFileRoute("/meeting/$id")({
  component: MeetingPage,
});

function MeetingPage() {
  const { id } = Route.useParams();
  return <MeetingView meetingId={id} />;
}
