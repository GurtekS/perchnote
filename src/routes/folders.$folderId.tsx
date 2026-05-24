import { createFileRoute } from "@tanstack/react-router";
import { FolderExplorer } from "../components/folders/FolderExplorer";

export const Route = createFileRoute("/folders/$folderId")({
  component: FolderPage,
});

function FolderPage() {
  const { folderId } = Route.useParams();
  return <FolderExplorer activeFolderId={folderId} />;
}
