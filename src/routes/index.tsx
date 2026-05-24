import { createFileRoute } from "@tanstack/react-router";
import { TodayView } from "../components/home/TodayView";

export const Route = createFileRoute("/")({
  component: TodayView,
});
