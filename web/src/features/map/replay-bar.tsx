import { Link } from "@tanstack/react-router"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClapperboardIcon,
  ExternalLinkIcon,
  PauseIcon,
  PlayIcon,
  XIcon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatTimeRange } from "@/lib/format"
import { clampStep, nextPlayStep, REPLAY_STEP_MS, stepAt, stepBy } from "@/lib/replay"
import { stepCentre, type Session } from "@/lib/sessions"
import { stepEntryId, stepSummary } from "@/lib/step-text"

interface ReplayBarProps {
  /** The session being replayed; undefined while the history loads or when it is gone. */
  session: Session | undefined
  loading: boolean
  /** The session key from the URL, for the link back when the session is gone. */
  sessionKey: string
  step: number | undefined
  onStep: (step: number) => void
  onExit: () => void
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Session replay"
      className="flex w-full max-w-xl flex-col gap-2 rounded-lg border bg-background/95 p-2.5 shadow-sm backdrop-blur"
    >
      {children}
    </section>
  )
}

/** Previous / play / next and a scrubber for one session, with the current step's summary. */
export function ReplayBar({ session, loading, sessionKey, step, onStep, onExit }: ReplayBarProps) {
  const [playing, setPlaying] = useState(false)
  const current = session ? clampStep(session, step) : 1
  const stepRef = useRef(onStep)
  useEffect(() => {
    stepRef.current = onStep
  })

  // Play: move on every REPLAY_STEP_MS, stop after the last step.
  useEffect(() => {
    if (!playing || !session) return
    const timer = setTimeout(() => {
      const next = nextPlayStep(session, current)
      if (next === undefined) setPlaying(false)
      else stepRef.current(next)
    }, REPLAY_STEP_MS)
    return () => clearTimeout(timer)
  }, [playing, session, current])
  const atEnd = !!session && current >= session.steps.length
  useEffect(() => {
    if (playing && atEnd) setPlaying(false)
  }, [playing, atEnd])

  if (!session) {
    return (
      <Frame>
        <div className="flex items-center gap-2">
          <ClapperboardIcon className="size-4 shrink-0 text-muted-foreground" />
          {loading ? (
            <Skeleton className="h-5 flex-1" />
          ) : (
            <p className="min-w-0 flex-1 text-sm">
              This session is no longer in the bridge&apos;s log (the game was restarted or the save reloaded).
            </p>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Exit replay" onClick={onExit}>
            <XIcon />
          </Button>
        </div>
        {!loading && (
          <Link to="/activity" search={{ session: sessionKey }} className={buttonVariants({ variant: "outline", size: "sm", className: "self-start" })}>
            Back to the activity page
          </Link>
        )}
      </Frame>
    )
  }

  const total = session.steps.length
  const active = stepAt(session, current)
  const hasPosition = stepCentre(active) !== undefined

  return (
    <Frame>
      <div className="flex items-center gap-1.5">
        <ClapperboardIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium">
          Session {session.number}
          <span className="font-normal text-muted-foreground"> · {formatTimeRange(session.startMs, session.endMs)}</span>
        </span>
        <Link
          to="/activity"
          search={{ session: session.key }}
          className={buttonVariants({ variant: "ghost", size: "xs", className: "ms-auto" })}
        >
          Back to session
        </Link>
        <Button variant="ghost" size="icon-sm" aria-label="Exit replay" onClick={onExit}>
          <XIcon />
        </Button>
      </div>

      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous step"
          disabled={current <= 1}
          onClick={() => {
            setPlaying(false)
            onStep(stepBy(session, current, -1))
          }}
        >
          <ChevronLeftIcon />
        </Button>
        <Button
          variant={playing ? "secondary" : "outline"}
          size="icon-sm"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => {
            if (playing) setPlaying(false)
            else {
              if (atEnd) onStep(1)
              setPlaying(true)
            }
          }}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next step"
          disabled={atEnd}
          onClick={() => {
            setPlaying(false)
            onStep(stepBy(session, current, 1))
          }}
        >
          <ChevronRightIcon />
        </Button>
        <input
          type="range"
          aria-label="Step"
          min={1}
          max={total}
          step={1}
          value={current}
          disabled={total <= 1}
          onChange={(event) => {
            setPlaying(false)
            onStep(Number(event.target.value))
          }}
          className="mx-1 h-6 min-w-0 flex-1 accent-primary"
        />
        <span className="w-14 shrink-0 text-end text-sm tabular-nums" aria-live="polite">
          {current} / {total}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="min-w-0 flex-1 basis-48 break-words first-letter:uppercase" data-testid="replay-summary">
          {stepSummary(active)}
        </span>
        <Link
          to="/activity"
          search={{ session: session.key, entry: stepEntryId(active) }}
          className={buttonVariants({ variant: "ghost", size: "xs" })}
        >
          Details
          <ExternalLinkIcon data-icon="inline-end" />
        </Link>
      </div>
      {!hasPosition && (
        <p className="text-xs text-muted-foreground">This step has no position, so the map stays where it is.</p>
      )}
    </Frame>
  )
}
