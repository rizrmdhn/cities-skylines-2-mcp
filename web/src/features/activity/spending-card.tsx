import { useQuery } from "@tanstack/react-query"
import { LoaderCircleIcon } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import type { History } from "@/lib/bridge-types"
import { formatMoney } from "@/lib/format"
import { historyQuery } from "@/lib/queries"

function limitSourceLabel(source: string) {
  return source === "CS2MCP_SPEND_LIMIT" ? "set by CS2MCP_SPEND_LIMIT" : "set in the game's options"
}

function SpendingBody({ history }: { history: History }) {
  if (history.spendingLimit === null) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-2xl font-semibold tabular-nums">
          {formatMoney(history.sessionSpent)}
        </span>
        <span className="text-sm text-muted-foreground">
          spent by AI build requests. No spending limit is set (Options &gt; CS2MCP).
        </span>
      </div>
    )
  }
  const remaining = history.spendingLimitRemaining ?? 0
  const used = Math.min(100, (history.sessionSpent / history.spendingLimit) * 100)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-2xl font-semibold tabular-nums">
          {formatMoney(remaining)}
        </span>
        <span className="text-sm text-muted-foreground">
          left of the {formatMoney(history.spendingLimit)} limit,{" "}
          {limitSourceLabel(history.spendingLimitSource)}
        </span>
      </div>
      <Progress value={used} aria-valuetext={`${Math.round(used)}% of the limit spent`}>
        <ProgressLabel>{formatMoney(history.sessionSpent)} spent</ProgressLabel>
        <span className="ms-auto text-sm tabular-nums text-muted-foreground">
          {Math.round(used)}%
        </span>
      </Progress>
      {remaining === 0 && (
        <span className="text-sm text-destructive">
          Limit reached: the bridge refuses build requests until you reset the counter in the game.
        </span>
      )}
    </div>
  )
}

export function SpendingCard({ className }: { className?: string }) {
  const history = useQuery(historyQuery())

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>AI spending</CardTitle>
        <CardDescription>Money spent by AI build requests since the save was loaded</CardDescription>
        {history.data?.batchRunning && (
          <CardAction>
            <Badge variant="secondary">
              <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
              Batch running
            </Badge>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <QueryError title="Could not load AI history" error={history.error} />
        ) : history.data ? (
          <SpendingBody history={history.data} />
        ) : (
          <Skeleton className="h-16" />
        )}
      </CardContent>
    </Card>
  )
}
