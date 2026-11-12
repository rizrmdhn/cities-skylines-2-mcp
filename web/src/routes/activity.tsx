import { createFileRoute } from "@tanstack/react-router"
import { HistoryIcon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { z } from "zod"

import { QueryError } from "@/components/query-error"
import { WaitingForCity } from "@/components/waiting-for-city"
import { Accordion } from "@/components/ui/accordion"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { EntrySheet } from "@/features/activity/entry-sheet"
import { ExportMenu } from "@/features/activity/export-menu"
import { exportHistory, exportSession, type ExportFormat } from "@/features/activity/run-export"
import { SessionCard } from "@/features/activity/session-card"
import { SpendingCard } from "@/features/activity/spending-card"
import { useActivity } from "@/features/activity/use-activity"
import { useConnection } from "@/lib/connection"
import { actionLabel } from "@/lib/format"
import { sessionOfEntry, stepMatches, type Session, type Step } from "@/lib/sessions"

const STATUS_FILTERS = ["all", "ok", "failed"] as const
type StatusFilter = (typeof STATUS_FILTERS)[number]
const ALL_KINDS = "all"

function isStatusFilter(value: string): value is StatusFilter {
  return (STATUS_FILTERS as readonly string[]).includes(value)
}

const activitySearch = z.object({
  status: z.enum(STATUS_FILTERS).default("all").catch("all"),
  kind: z.string().optional().catch(undefined),
  entry: z.number().int().optional().catch(undefined),
  /** A session's key: opened and scrolled to (the map replay links back with it). */
  session: z.string().optional().catch(undefined),
})

export const Route = createFileRoute("/activity")({
  validateSearch: activitySearch,
  component: ActivityPage,
})

function ActivityPage() {
  const connection = useConnection()
  if (!connection.ready) return <WaitingForCity />
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <SpendingCard />
      <SessionTimeline />
    </div>
  )
}

interface Shown {
  session: Session
  steps: Step[]
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function SessionTimeline() {
  const { status, kind, entry: selectedId, session: focusKey } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { history, entries, sessions, city } = useActivity()
  // Sessions the user opened or closed by hand; the others follow the default (newest, or the linked one).
  const [toggled, setToggled] = useState<Record<string, boolean>>({})

  const all = sessions ?? []
  const kinds = [...new Set((entries ?? []).map((entry) => entry.path))].sort()
  const kindItems = [
    { value: ALL_KINDS, label: "All actions" },
    ...kinds.map((path) => ({ value: path, label: actionLabel(path) })),
  ]
  // A session is listed when one of its steps matches; it then lists the matching steps.
  const shown: Shown[] = all
    .map((session) => ({ session, steps: session.steps.filter((step) => stepMatches(step, status, kind)) }))
    .filter(({ steps }) => steps.length > 0)
  const shownSessions = shown.map(({ session }) => session)
  const selected = entries?.find((entry) => entry.id === selectedId)
  const selectedSessionKey = sessionOfEntry(all, selectedId)?.key
  const latestKey = all[0]?.key

  const isOpen = (key: string) => toggled[key] ?? key === (focusKey ?? selectedSessionKey ?? latestKey)
  const openKeys = shown.filter(({ session }) => isOpen(session.key)).map(({ session }) => session.key)

  const done = (name: string) => toast.success(`Saved ${name}`)
  const filtered = status !== "all" || kind !== undefined
  const actionCount = shownSessions.reduce((sum, session) => sum + session.steps.length, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>AI sessions</CardTitle>
        <CardDescription>
          {history.data
            ? `Newest first. ${filtered ? `${shownSessions.length} of ${plural(all.length, "session")}` : plural(all.length, "session")}, ${plural(history.data.total, "change")} since the save was loaded. A pause of 15 minutes starts a new session.`
            : "Newest first"}
        </CardDescription>
        <CardAction className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Result"
            value={[status]}
            onValueChange={(value: string[]) => {
              const next = value.at(-1)
              if (next && isStatusFilter(next)) navigate({ search: (prev) => ({ ...prev, status: next }), replace: true })
            }}
          >
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="ok">Done</ToggleGroupItem>
            <ToggleGroupItem value="failed">Failed</ToggleGroupItem>
          </ToggleGroup>
          <Select
            items={kindItems}
            value={kind ?? ALL_KINDS}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  kind: value === ALL_KINDS || value === null ? undefined : String(value),
                }),
                replace: true,
              })
            }
          >
            <SelectTrigger size="sm" aria-label="Action" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {kindItems.map((item) => (
                  <SelectItem key={item.value} value={item.value} className="capitalize">
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {shownSessions.length > 0 && (
            <ExportMenu
              what={`${plural(shownSessions.length, "session")}, ${plural(actionCount, "action")}`}
              label="Export all"
              onExport={(format: ExportFormat) =>
                done(exportHistory(shownSessions, format, { city, filters: { status, kind } }))
              }
            />
          )}
        </CardAction>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <QueryError title="Could not load AI history" error={history.error} />
        ) : !history.data ? (
          <Skeleton className="h-64" />
        ) : shown.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>{all.length === 0 ? "No changes yet" : "Nothing matches"}</EmptyTitle>
              <EmptyDescription>
                {all.length === 0
                  ? "Every build, demolish, zoning or setting change the AI makes appears here, grouped into sessions."
                  : "No change matches these filters."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Accordion
            multiple
            value={openKeys}
            onValueChange={(next: unknown[]) => {
              const keys = new Set(next.map(String))
              setToggled(Object.fromEntries(shown.map(({ session }) => [session.key, keys.has(session.key)])))
            }}
          >
            {shown.map(({ session, steps }) => (
              <SessionCard
                key={session.key}
                session={session}
                steps={steps}
                stepsTotal={session.steps.length}
                isLatest={session.key === latestKey}
                focused={session.key === focusKey}
                selectedId={selectedId}
                onExport={(format) => done(exportSession(session, format, { city }))}
              />
            ))}
          </Accordion>
        )}
      </CardContent>
      <EntrySheet
        entry={selected}
        onClose={() => navigate({ search: (prev) => ({ ...prev, entry: undefined }) })}
      />
    </Card>
  )
}
