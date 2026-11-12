import { Link } from "@tanstack/react-router"
import { CircleCheckIcon, CircleXIcon, ClapperboardIcon, LoaderCircleIcon } from "lucide-react"
import { useEffect, useRef } from "react"

import { Badge } from "@/components/ui/badge"
import { buttonVariants } from "@/components/ui/button"
import { AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { ExportMenu } from "@/features/activity/export-menu"
import { StepTable } from "@/features/activity/step-table"
import { actionLabel, formatMoney, formatMoneyDelta, formatTimeRange } from "@/lib/format"
import { stepCentre, formatDuration, type Session, type Step } from "@/lib/sessions"
import type { ExportFormat } from "@/features/activity/run-export"

const SHOWN_ACTIONS = 5

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/** "around (120, -340)" or "(0, 300) to (600, 300)". */
function placeText(session: Session) {
  const place = session.place
  if (!place) return undefined
  const round = (n: number) => Math.round(n)
  if (place.min.x === place.max.x && place.min.z === place.max.z) {
    return `at (${round(place.centre.x)}, ${round(place.centre.z)})`
  }
  return `around (${round(place.centre.x)}, ${round(place.centre.z)})`
}

function Facts({ session }: { session: Session }) {
  const rows: [string, string][] = []
  if (session.gameTimeStart) {
    rows.push([
      "In game",
      session.gameTimeStart === session.gameTimeEnd
        ? session.gameTimeStart
        : `${session.gameTimeStart} → ${session.gameTimeEnd}`,
    ])
  }
  rows.push(["Money", `${formatMoney(session.spent)} spent, net ${formatMoneyDelta(session.netMoney)}`])
  if (session.prefabs.length > 0) {
    rows.push([
      "Assets",
      session.prefabs.map((item) => (item.count > 1 ? `${item.name} × ${item.count}` : item.name)).join(", "),
    ])
  }
  rows.push(["Where", session.place ? placeText(session)! : "no positions recorded"])
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-1 pb-3 text-sm">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One session: its summary as the accordion header, with replay and export beside it, its steps inside. */
export function SessionCard({
  session,
  steps,
  stepsTotal,
  isLatest,
  focused,
  selectedId,
  onExport,
}: {
  session: Session
  /** The steps to list (the page's filters applied). */
  steps: readonly Step[]
  stepsTotal: number
  isLatest: boolean
  /** Linked to from elsewhere (`?session=`): scroll to it. */
  focused: boolean
  selectedId: number | undefined
  onExport: (format: ExportFormat) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: "start", behavior: "smooth" })
  }, [focused])

  const actions = session.actions.slice(0, SHOWN_ACTIONS)
  const hiddenActions = session.actions.length - actions.length
  const hasPlace = session.steps.some((step) => stepCentre(step))
  const place = placeText(session)

  return (
    <AccordionItem
      value={session.key}
      ref={ref}
      data-testid={`session-${session.number}`}
      data-focused={focused ? "" : undefined}
      className="scroll-mt-4 rounded-lg border px-3 data-[focused]:ring-2 data-[focused]:ring-ring/60 not-last:mb-3 not-last:border-b"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <AccordionTrigger className="min-w-0 flex-[1_1_20rem] flex-wrap gap-y-1 hover:no-underline">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-base font-semibold">Session {session.number}</span>
              {isLatest && !session.running && <Badge variant="secondary">Latest</Badge>}
              {session.running && (
                <Badge variant="secondary">
                  <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />
                  Batch running
                </Badge>
              )}
              <span className="font-normal text-muted-foreground tabular-nums">
                {formatTimeRange(session.startMs, session.endMs)} · {formatDuration(session.durationMs)}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-normal">
              <span>{plural(session.steps.length, "action")}</span>
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <CircleCheckIcon className="size-3.5" />
                {session.succeeded} done
              </span>
              {session.failed > 0 && (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <CircleXIcon className="size-3.5" />
                  {session.failed} failed
                </span>
              )}
              <span className="tabular-nums">{formatMoney(session.spent)} spent</span>
              {place && <span className="text-muted-foreground">{place}</span>}
            </div>
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {actions.map((item) => (
                  <Badge key={item.name} variant="outline" className="capitalize">
                    {actionLabel(item.name)}
                    {item.count > 1 && <span className="text-muted-foreground">× {item.count}</span>}
                  </Badge>
                ))}
                {hiddenActions > 0 && <Badge variant="ghost">+{hiddenActions} more</Badge>}
              </div>
            )}
          </div>
        </AccordionTrigger>
        <div className="flex shrink-0 items-center gap-1.5 py-2">
          {hasPlace && (
            <Link
              to="/map"
              search={{ replay: session.key, step: 1 }}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              aria-label={`Replay session ${session.number} on the map`}
            >
              <ClapperboardIcon data-icon="inline-start" />
              Replay
            </Link>
          )}
          <ExportMenu
            what={`Session ${session.number}`}
            iconOnly
            label="Export"
            onExport={onExport}
          />
        </div>
      </div>
      <AccordionContent>
        <Facts session={session} />
        {steps.length < stepsTotal && (
          <p className="px-1 pb-2 text-xs text-muted-foreground">
            Showing {steps.length} of {stepsTotal} actions that match the filters.
          </p>
        )}
        <StepTable steps={steps} selectedId={selectedId} running={session.running} />
      </AccordionContent>
    </AccordionItem>
  )
}
