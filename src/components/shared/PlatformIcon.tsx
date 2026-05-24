import { Video, Monitor, Phone, Users, HelpCircle } from "lucide-react";

const platformConfig: Record<string, { icon: typeof Video; label: string }> = {
  zoom: { icon: Video, label: "Zoom" },
  google_meet: { icon: Monitor, label: "Google Meet" },
  teams: { icon: Users, label: "Teams" },
  webex: { icon: Phone, label: "Webex" },
  slack: { icon: Monitor, label: "Slack" },
  in_person: { icon: Users, label: "In Person" },
};

interface PlatformIconProps {
  platform: string;
  size?: number;
  className?: string;
}

export function PlatformIcon({ platform, size = 16, className = "" }: PlatformIconProps) {
  const config = platformConfig[platform] || { icon: HelpCircle, label: "Unknown" };
  const Icon = config.icon;
  return <Icon size={size} className={className} aria-label={config.label} />;
}
