import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRightIcon } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { buttonVariants } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ResultBadge } from "@/features/activity/result-badge"
import { actionLabel, formatMoneyDelta, formatTime } from "@/lib/format"
import { historyQuery } from "@/lib/queries"

const SHOWN = 5

export function RecentActivityCard({ className }: { className?: string }) {
  const history = useQuery(historyQuery())
  const entries = history.data?.entries.slice(0, SHOWN) ?? []

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Latest AI changes</CardTitle>
        <CardDescription>
          {history.data ? `${history.data.total} changes this session` : "Changes made through the bridge"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <QueryError title="Could not load AI history" error={history.error} />
        ) : !history.data ? (
          <Skeleton className="h-32" />
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The AI has not changed anything since the save was loaded.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link
                  to="/activity"
                  search={{ entry: entry.id }}
                  className="flex items-center gap-2 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate capitalize">
                    {actionLabel(entry.path)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatMoneyDelta(entry.moneyDelta)}
                  </span>
                  <ResultBadge entry={entry} />
                  <span className="w-16 text-end text-xs tabular-nums text-muted-foreground">
                    {formatTime(entry.timeUtc)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <CardFooter>
        <Link to="/activity" className={buttonVariants({ variant: "outline", size: "sm" })}>
          All activity
          <ArrowRightIcon data-icon="inline-end" />
        </Link>
      </CardFooter>
    </Card>
  )
}
