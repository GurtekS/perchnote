import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../lib/ipc";

export function useFolders() {
  return useQuery({
    queryKey: ["folders"],
    queryFn: ipc.listFolders,
  });
}

export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, color, icon, parentId }: { name: string; color: string; icon: string; parentId?: string | null }) =>
      ipc.createFolder(name, color, icon, parentId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["folders"] }),
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.deleteFolder(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["folders"] }),
  });
}
