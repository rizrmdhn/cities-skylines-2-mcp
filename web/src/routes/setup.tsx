import { createFileRoute } from "@tanstack/react-router"

import { SetupWizard } from "@/features/setup/setup-wizard"

/** First-run setup wizard of the desktop app; the root layout renders it without header or nav. */
export const Route = createFileRoute("/setup")({
  component: SetupWizard,
})
