import { createFileRoute } from "@tanstack/react-router";
import { FolderExplorer } from "../components/folders/FolderExplorer";

export const Route = createFileRoute("/folders/")({
  component: FoldersPage,
});

function FoldersPage() {
  return <FolderExplorer activeFolderId={null} />;
}
