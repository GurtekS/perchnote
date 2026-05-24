import { createFileRoute } from "@tanstack/react-router";
import { CalendarView } from "../components/calendar/CalendarView";

export const Route = createFileRoute("/calendar")({
  component: CalendarView,
});
