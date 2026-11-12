import { createFileRoute } from "@tanstack/react-router"

import { OverlayView } from "@/features/overlay/overlay-view"

/** Page of the desktop app's always-on-top overlay window; the root layout renders it without header or nav. */
export const Route = createFileRoute("/overlay")({
  component: OverlayView,
})
