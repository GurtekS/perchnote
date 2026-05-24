interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = "" }: SkeletonProps) {
  return <div className={`skeleton ${className}`} />;
}

export function MeetingCardSkeleton() {
  return (
    <div className="px-4 py-3 space-y-1.5">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-4 w-12 rounded-full" />
      </div>
    </div>
  );
}
