import { createFileRoute, Outlet, useMatches, useNavigate } from "@tanstack/react-router";
import {
  SETTINGS_SECTION_IDS,
  SettingsView,
  type SettingsSection,
} from "../components/settings/SettingsView";

interface SettingsSearch {
  section?: SettingsSection;
}

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: (search: Record<string, unknown>): SettingsSearch => ({
    section: isSettingsSection(search.section) ? search.section : undefined,
  }),
});

function SettingsPage() {
  const matches = useMatches();
  const navigate = useNavigate();
  const { section } = Route.useSearch();
  const hasChildRoute = matches.some(
    (m) => m.routeId !== "/settings" && m.routeId !== "__root__" && m.routeId !== "/"
  );

  if (hasChildRoute) {
    return <Outlet />;
  }

  return (
    <SettingsView
      initialSection={section}
      onRunSetup={() => {
        void navigate({ to: "/onboarding" });
      }}
      onSectionChange={(nextSection) => {
        void navigate({ to: "/settings", search: { section: nextSection } });
      }}
    />
  );
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return (
    typeof value === "string" &&
    SETTINGS_SECTION_IDS.includes(value as SettingsSection)
  );
}
