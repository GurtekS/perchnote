import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  OnboardingFlow,
  type OnboardingRepairSection,
} from "../components/settings/OnboardingFlow";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPreviewPage,
});

function OnboardingPreviewPage() {
  const navigate = useNavigate();

  return (
    <OnboardingFlow
      mode="preview"
      onComplete={() => {
        void navigate({ to: "/" });
      }}
      onOpenSettingsSection={(section: OnboardingRepairSection) => {
        void navigate({ to: "/settings", search: { section } });
      }}
    />
  );
}
