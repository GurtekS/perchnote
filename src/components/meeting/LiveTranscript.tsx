/**
 * @deprecated - Live transcript display has been removed from the recording view.
 * Transcript is now background-only during recording and available in TranscriptDrawer afterward.
 * This component is kept as a stub for backward compatibility.
 */

interface LiveTranscriptProps {
  segments: Array<{
    text: string;
    start_ms: number;
    end_ms: number;
    speaker: string | null;
    confidence?: number | null;
  }>;
  status: string | null;
}

export function LiveTranscript(_props: LiveTranscriptProps) {
  return null;
}
