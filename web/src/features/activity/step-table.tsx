import { Link, useNavigate } from "@tanstack/react-router"
import { ChevronRightIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react"
import { Fragment, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ResultBadge } from "@/features/activity/result-badge"
import type { HistoryEntry } from "@/lib/bridge-types"
import { actionLabel, formatMoneyDelta, formatTime } from "@/lib/format"
import { stepEntries, type Step } from "@/lib/sessions"
import { stepDetail, stepEntryId } from "@/lib/step-text"

function StepResult({ step, running }: { step: Step; running: boolean }) {
  if (step.kind === "batch" && !step.entry) {
    return running ? (
      <Badge variant="secondary">
        <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
        Running
      </Badge>
    ) : (
      <Badge variant="outline">Result not logged</Badge>
    )
  }
  // The batch request itself answers 200 even when a part failed: say how many did.
  if (step.entry?.ok && step.failedParts > 0) {
    return (
      <Badge variant="destructive">
        <CircleXIcon data-icon="inline-start" />
        {step.failedParts} of {step.parts.length} failed
      </Badge>
    )
  }
  return step.entry ? <ResultBadge entry={step.entry} /> : null
}

function EntryLink({ entry, children }: { entry: HistoryEntry; children: React.ReactNode }) {
  return (
    <Link
      to="/activity"
      search={(prev) => ({ ...prev, entry: entry.id })}
      className="capitalize outline-none hover:underline focus-visible:underline"
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  )
}

/** The steps of one session: a batch is one row that unfolds into its parts. */
export function StepTable({
  steps,
  selectedId,
  running,
}: {
  steps: readonly Step[]
  selectedId: number | undefined
  /** The bridge is running a batch and this is the session's newest step. */
  running: boolean
}) {
  const navigate = useNavigate({ from: "/activity" })
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set())
  const open = (id: number) => navigate({ search: (prev) => ({ ...prev, entry: id }) })
  const toggle = (index: number) =>
    setUnfolded((current) => {
      const next = new Set(current)
      if (!next.delete(index)) next.add(index)
      return next
    })

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-10">#</TableHead>
          <TableHead>Action</TableHead>
          <TableHead>Result</TableHead>
          <TableHead className="text-end">Money</TableHead>
          <TableHead className="max-sm:hidden">In game</TableHead>
          <TableHead className="text-end">Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {steps.map((step) => {
          const isBatch = step.kind === "batch"
          const holdsSelected = stepEntries(step).some((entry) => entry.id === selectedId)
          const showParts = isBatch && (unfolded.has(step.index) || holdsSelected)
          const detail = stepDetail(step)
          const primary = step.entry ?? step.parts[0]
          const newest = running && step === steps.at(-1)
          return (
            <Fragment key={step.index}>
              <TableRow
                data-state={step.entry && step.entry.id === selectedId ? "selected" : undefined}
                className="cursor-pointer"
                onClick={() => open(stepEntryId(step))}
              >
                <TableCell className="text-muted-foreground tabular-nums">{step.index}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {isBatch && (
                      <button
                        type="button"
                        aria-expanded={showParts}
                        aria-label={`${showParts ? "Hide" : "Show"} the ${step.parts.length} parts of step ${step.index}`}
                        className="-ms-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={(event) => {
                          event.stopPropagation()
                          toggle(step.index)
                        }}
                      >
                        <ChevronRightIcon className={`size-4 transition-transform ${showParts ? "rotate-90" : ""}`} />
                      </button>
                    )}
                    <EntryLink entry={primary}>{actionLabel(step.path)}</EntryLink>
                    {isBatch && (
                      <Badge variant="outline">
                        {step.parts.length} part{step.parts.length === 1 ? "" : "s"}
                      </Badge>
                    )}
                    {detail && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden">{detail}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <StepResult step={step} running={newest} />
                </TableCell>
                <TableCell className="text-end tabular-nums">{formatMoneyDelta(step.moneyDelta)}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums max-sm:hidden">
                  {primary.gameTime ?? "-"}
                </TableCell>
                <TableCell className="text-end text-muted-foreground tabular-nums">
                  {formatTime(new Date(step.startMs).toISOString())}
                </TableCell>
              </TableRow>
              {showParts &&
                step.parts.map((part, i) => (
                  <TableRow
                    key={part.id}
                    data-state={part.id === selectedId ? "selected" : undefined}
                    className="cursor-pointer bg-muted/30"
                    onClick={() => open(part.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {step.index}.{i + 1}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 ps-6">
                        <EntryLink entry={part}>{actionLabel(part.path)}</EntryLink>
                        {part.query?.prefab && (
                          <span className="min-w-0 truncate text-xs text-muted-foreground max-sm:hidden">
                            {part.query.prefab}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ResultBadge entry={part} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{formatMoneyDelta(part.moneyDelta)}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums max-sm:hidden">
                      {part.gameTime ?? "-"}
                    </TableCell>
                    <TableCell className="text-end text-muted-foreground tabular-nums">
                      {formatTime(part.timeUtc)}
                    </TableCell>
                  </TableRow>
                ))}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}
