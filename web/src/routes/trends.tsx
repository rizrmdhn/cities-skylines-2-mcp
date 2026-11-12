import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { TrendsView } from "@/features/trends/trends-view"

const trendsSearch = z.object({
  /** City key from /api/desktop/trends/cities; default: the loaded city. */
  city: z.string().optional().catch(undefined),
  axis: z.enum(["game", "real"]).default("game").catch("game"),
  range: z.string().default("all").catch("all"),
})

export const Route = createFileRoute("/trends")({
  validateSearch: trendsSearch,
  component: TrendsPage,
})

function TrendsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <TrendsView
      search={search}
      onSearch={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
    />
  )
}
