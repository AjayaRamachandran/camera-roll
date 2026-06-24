import { Play } from "lucide-react";

interface PlayBadgeProps {
  /** Icon edge length in px. */
  size?: number;
}

/**
 * The marker that tells a video apart from a photo: a filled, rounded white
 * play glyph with a soft drop shadow so it reads on any thumbnail. Lucide's
 * Play already has rounded joins; filling it and adding a matching stroke
 * rounds the tips too. Placement (e.g. bottom-left of a grid cell) is the
 * caller's job.
 */
export default function PlayBadge({ size = 22 }: PlayBadgeProps) {
  return (
    <Play
      size={size}
      className="text-white"
      fill="currentColor"
      strokeWidth={size / 6}
      strokeLinejoin="round"
      style={{ filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55))" }}
    />
  );
}
