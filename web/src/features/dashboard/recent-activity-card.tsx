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
import { StepResult } from "@/features/activity/step-table"
import { useActivity } from "@/features/activity/use-activity"
import { actionLabel, formatMoney, formatMoneyDelta, formatTime } from "@/lib/format"
import { stepEntryId } from "@/lib/step-text"

const SHOWN = 5

export function RecentActivityCard({ className }: { className?: string }) {
  const { history, sessions } = useActivity()
  // The newest steps across sessions: a batch is one row, not one per part.
  const steps = (sessions ?? []).flatMap((session) => session.steps.map((step) => ({ session, step })).reverse()).slice(0, SHOWN)
  const latest = sessions?.[0]

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Latest AI changes</CardTitle>
        <CardDescription>
          {latest
            ? `Session ${latest.number}: ${latest.steps.length} action${latest.steps.length === 1 ? "" : "s"}, ${formatMoney(latest.spent)} spent`
            : "Changes made through the bridge"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {history.isError ? (
          <QueryError title="Could not load AI history" error={history.error} />
        ) : !history.data ? (
          <Skeleton className="h-32" />
        ) : steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The AI has not changed anything since the save was loaded.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {steps.map(({ session, step }) => (
              <li key={`${session.key}-${step.index}`}>
                <Link
                  to="/activity"
                  search={{ entry: stepEntryId(step) }}
                  className="flex items-center gap-2 rounded-md text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate capitalize">
                    {actionLabel(step.path)}
                    {step.kind === "batch" && (
                      <span className="text-muted-foreground normal-case"> · {step.parts.length} parts</span>
                    )}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatMoneyDelta(step.moneyDelta)}
                  </span>
                  <StepResult step={step} running={session.running && step === session.steps.at(-1)} />
                  <span className="w-16 text-end text-xs tabular-nums text-muted-foreground">
                    {formatTime(new Date(step.startMs).toISOString())}
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
