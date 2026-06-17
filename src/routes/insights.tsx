import { createFileRoute } from "@tanstack/react-router";
import { InsightsView } from "../components/insights/InsightsView";

export const Route = createFileRoute("/insights")({
  component: InsightsView,
});
