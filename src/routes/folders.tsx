import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/folders")({
  component: FoldersLayout,
});

function FoldersLayout() {
  return <Outlet />;
}
