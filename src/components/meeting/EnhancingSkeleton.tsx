interface Props {
  loading?: boolean;
}

export function EnhancingSkeleton({ loading = false }: Props) {
  return (
    <div className="py-2 space-y-5 animate-pulse" aria-label={loading ? "Loading notes…" : "Enhancing notes…"}>
      <div className="h-5 w-2/5 rounded-md bg-bg-tertiary" />
      <div className="space-y-2.5">
        <div className="h-3.5 w-full rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-[92%] rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-4/5 rounded-md bg-bg-tertiary" />
      </div>
      <div className="h-5 w-1/3 rounded-md bg-bg-tertiary" />
      <div className="space-y-2.5 pl-4">
        <div className="h-3.5 w-[88%] rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-3/4 rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-[82%] rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-2/3 rounded-md bg-bg-tertiary" />
      </div>
      <div className="h-5 w-2/5 rounded-md bg-bg-tertiary" />
      <div className="space-y-2.5">
        <div className="h-3.5 w-full rounded-md bg-bg-tertiary" />
        <div className="h-3.5 w-[85%] rounded-md bg-bg-tertiary" />
      </div>
      {!loading && (
        <div className="flex items-center gap-2 pt-1">
          <div className="w-1.5 h-1.5 rounded-full bg-accent/50 animate-ping" />
          <span className="text-xs text-text-muted">Enhancing your notes…</span>
        </div>
      )}
    </div>
  );
}
