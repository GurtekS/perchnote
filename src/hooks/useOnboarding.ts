import { useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc } from "../lib/ipc";

export type OnboardingStepId = "privacy" | "audio" | "ai" | "calendar" | "test" | "start";

export interface OnboardingProgress {
  isComplete: boolean;
  viewedAudioSetup: boolean;
  viewedAiSetup: boolean;
  viewedCalendarSetup: boolean;
  resumeStep: OnboardingStepId | null;
}

export const ONBOARDING_STATE_QUERY_KEY = ["onboarding-state"];

const ONBOARDING_COMPLETED_KEY = "onboarding_completed";
const ONBOARDING_RESUME_STEP_KEY = "onboarding_resume_step";
const ONBOARDING_STEP_MILESTONE_KEYS: Partial<Record<OnboardingStepId, string>> = {
  audio: "onboarding_viewed_audio_setup",
  ai: "onboarding_viewed_ai_setup",
  calendar: "onboarding_viewed_calendar_setup",
};

const STEP_IDS: OnboardingStepId[] = ["privacy", "audio", "ai", "calendar", "test", "start"];

const EMPTY_PROGRESS: OnboardingProgress = {
  isComplete: false,
  viewedAudioSetup: false,
  viewedAiSetup: false,
  viewedCalendarSetup: false,
  resumeStep: null,
};

function parseBoolean(value: string | null): boolean {
  return value === "true";
}

function parseStepId(value: string | null): OnboardingStepId | null {
  return STEP_IDS.includes(value as OnboardingStepId) ? (value as OnboardingStepId) : null;
}

export function useOnboarding() {
  const queryClient = useQueryClient();

  const { data: progress, isLoading } = useQuery<OnboardingProgress>({
    queryKey: ONBOARDING_STATE_QUERY_KEY,
    queryFn: async () => {
      const [
        completed,
        viewedAudioSetup,
        viewedAiSetup,
        viewedCalendarSetup,
        resumeStep,
      ] = await Promise.all([
        ipc.getSetting(ONBOARDING_COMPLETED_KEY),
        ipc.getSetting(ONBOARDING_STEP_MILESTONE_KEYS.audio!),
        ipc.getSetting(ONBOARDING_STEP_MILESTONE_KEYS.ai!),
        ipc.getSetting(ONBOARDING_STEP_MILESTONE_KEYS.calendar!),
        ipc.getSetting(ONBOARDING_RESUME_STEP_KEY),
      ]);

      return {
        isComplete: parseBoolean(completed),
        viewedAudioSetup: parseBoolean(viewedAudioSetup),
        viewedAiSetup: parseBoolean(viewedAiSetup),
        viewedCalendarSetup: parseBoolean(viewedCalendarSetup),
        resumeStep: parseStepId(resumeStep),
      };
    },
    retry: false,
  });

  const complete = useMutation({
    mutationFn: async () => {
      await Promise.all([
        ipc.setSetting(ONBOARDING_STEP_MILESTONE_KEYS.audio!, "true"),
        ipc.setSetting(ONBOARDING_STEP_MILESTONE_KEYS.ai!, "true"),
        ipc.setSetting(ONBOARDING_STEP_MILESTONE_KEYS.calendar!, "true"),
        ipc.setSetting(ONBOARDING_RESUME_STEP_KEY, "start"),
        ipc.setSetting(ONBOARDING_COMPLETED_KEY, "true"),
      ]);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ONBOARDING_STATE_QUERY_KEY }),
  });

  const markStepViewed = useCallback(
    async (stepId: OnboardingStepId) => {
      const milestoneKey = ONBOARDING_STEP_MILESTONE_KEYS[stepId];
      const writes = [ipc.setSetting(ONBOARDING_RESUME_STEP_KEY, stepId)];

      if (milestoneKey) {
        writes.push(ipc.setSetting(milestoneKey, "true"));
      }

      await Promise.all(writes);
      await queryClient.invalidateQueries({ queryKey: ONBOARDING_STATE_QUERY_KEY });
    },
    [queryClient],
  );

  return {
    progress: progress ?? EMPTY_PROGRESS,
    isComplete: progress?.isComplete ?? false,
    isLoading,
    completeOnboarding: complete.mutateAsync,
    markStepViewed,
  };
}
