/**
 * @deprecated - Replaced by AskAIOverlay (Cmd+J quick-invoke).
 * This component is kept as a stub for backward compatibility.
 * Use AskAIOverlay instead.
 */

interface ChatPanelProps {
  meetingId: string;
}

export function ChatPanel({ meetingId: _meetingId }: ChatPanelProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-text-muted p-8">
      <p className="text-sm">Chat has been replaced by Ask AI (Cmd+J).</p>
      <p className="text-xs mt-1 opacity-60">
        Press Cmd+J to ask questions about this meeting.
      </p>
    </div>
  );
}
