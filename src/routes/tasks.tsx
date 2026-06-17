import { createFileRoute } from "@tanstack/react-router";
import { TasksView } from "../components/tasks/TasksView";

export const Route = createFileRoute("/tasks")({
  component: TasksView,
});
