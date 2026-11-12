import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { HistoryIcon } from "lucide-react"
import { z } from "zod"

import { QueryError } from "@/components/query-error"
import { WaitingForCity } from "@/components/waiting-for-city"
import { Badge } from "@/components/ui/badge"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { EntrySheet } from "@/features/activity/entry-sheet"
import { ResultBadge } from "@/features/activity/result-badge"
import { SpendingCard } from "@/features/activity/spending-card"
import type { HistoryEntry } from "@/lib/bridge-types"
import { useConnection } from "@/lib/connection"
import { actionLabel, formatMoneyDelta, formatTime } from "@/lib/format"
import { historyQuery } from "@/lib/queries"

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
})

export const Route = createFileRoute("/activity")({
  validateSearch: activitySearch,
  component: ActivityPage,
})

function matches(entry: HistoryEntry, status: StatusFilter, kind: string | undefined) {
  if (status === "ok" && !entry.ok) return false
  if (status === "failed" && entry.ok) return false
  return kind === undefined || entry.path === kind
}

function ActivityPage() {
  const connection = useConnection()
  if (!connection.ready) return <WaitingForCity />
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">
      <SpendingCard />
      <ActivityTable />
    </div>
  )
}

function ActivityTable() {
  const { status, kind, entry: selectedId } = Route.useSearch()
  const navigate = Route.useNavigate()
  const history = useQuery(historyQuery())

  const entries = history.data?.entries ?? []
  const kinds = [...new Set(entries.map((entry) => entry.path))].sort()
  const visible = entries.filter((entry) => matches(entry, status, kind))
  const selected = entries.find((entry) => entry.id === selectedId)
  const kindItems = [
    { value: ALL_KINDS, label: "All actions" },
    ...kinds.map((path) => ({ value: path, label: actionLabel(path) })),
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Changes made through the bridge</CardTitle>
        <CardDescription>
          {history.data
            ? `Newest first. Showing ${visible.length} of ${history.data.total} changes since the save was loaded.`
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
        </CardAction>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <QueryError title="Could not load AI history" error={history.error} />
        ) : !history.data ? (
          <Skeleton className="h-64" />
        ) : visible.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>{entries.length === 0 ? "No changes yet" : "Nothing matches"}</EmptyTitle>
              <EmptyDescription>
                {entries.length === 0
                  ? "Every build, demolish, zoning or setting change the AI makes appears here."
                  : "No change matches these filters."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-end">Money</TableHead>
                <TableHead className="max-sm:hidden">In game</TableHead>
                <TableHead className="text-end">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((entry) => (
                <TableRow
                  key={entry.id}
                  data-state={entry.id === selectedId ? "selected" : undefined}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({ search: (prev) => ({ ...prev, entry: entry.id }) })
                  }
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Link
                        to="/activity"
                        search={(prev) => ({ ...prev, entry: entry.id })}
                        className="capitalize outline-none hover:underline focus-visible:underline"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {actionLabel(entry.path)}
                      </Link>
                      {entry.batchChild && <Badge variant="outline">batch</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <ResultBadge entry={entry} />
                  </TableCell>
                  <TableCell className="text-end tabular-nums">
                    {formatMoneyDelta(entry.moneyDelta)}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums max-sm:hidden">
                    {entry.gameTime ?? "-"}
                  </TableCell>
                  <TableCell className="text-end text-muted-foreground tabular-nums">
                    {formatTime(entry.timeUtc)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <EntrySheet
        entry={selected}
        onClose={() => navigate({ search: (prev) => ({ ...prev, entry: undefined }) })}
      />
    </Card>
  )
}
