import { useId, useState } from "react"
import { AppWindowIcon, LockIcon, MessageSquareWarningIcon, PauseIcon, PlayIcon, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Connection } from "@/lib/connection"
import {
  formatSpeed,
  MAX_SPEED,
  SPEED_CHOICES,
  useSimulationControl,
  type SimulationChange,
} from "@/lib/simulation"
import { cn } from "@/lib/utils"

interface Notice {
  icon: LucideIcon
  /** Accessible name of the notice button; also shown next to the icon on wide screens. */
  label: string
  text: string
  /** Only the accessible name, never visible text (the header already says "Read-only"). */
  iconOnly?: boolean
}

const READ_ONLY_NOTICE: Notice = {
  icon: LockIcon,
  label: "Speed controls locked: read-only mode",
  text: "Read-only mode is on in the game (Options > CS2MCP), so the companion cannot pause the game or change its speed.",
  iconOnly: true,
}

const FORCED_PAUSE_NOTICE: Record<string, Notice> = {
  popup: {
    icon: MessageSquareWarningIcon,
    label: "Held by a game dialog",
    text: "A dialog is open in the game (for example a milestone reward). It holds the simulation at speed 0 until you close it in the game; the buttons here have no effect until then.",
  },
  unfocused: {
    icon: AppWindowIcon,
    label: "Game in background",
    text: "The game window is not focused and the game pauses while it is in the background. It runs again when you switch back to the game.",
  },
}

/**
 * Pause/resume and speed buttons for the app header. Shown only while a city is loaded; they
 * call POST /api/sim/control through the companion, the one state-changing call it makes.
 */
export function SimControls({ connection, className }: { connection: Connection; className?: string }) {
  const simulation = connection.ready ? connection.state?.simulation : null
  if (!simulation) return null
  return (
    <SimControlGroup
      className={className}
      paused={simulation.paused}
      speed={simulation.selectedSpeed}
      forcedPause={simulation.forcedPause}
      readOnly={connection.readOnly}
    />
  )
}

function SimControlGroup({
  paused,
  speed,
  forcedPause,
  readOnly,
  className,
}: {
  paused: boolean
  speed: number
  forcedPause: string | null
  readOnly: boolean
  className?: string
}) {
  const control = useSimulationControl()
  const descriptionId = useId()
  // The bridge reports speed 0 while paused: remember the last running speed to resume at it.
  const [resumeSpeed, setResumeSpeed] = useState<number | undefined>(undefined)
  if (!paused && speed > 0 && speed !== resumeSpeed) setResumeSpeed(speed)

  const notice = readOnly ? READ_ONLY_NOTICE : forcedPause ? FORCED_PAUSE_NOTICE[forcedPause] : undefined
  const change = (next: SimulationChange) => control.mutate(next)
  const resume = () => change(resumeSpeed !== undefined ? { speed: resumeSpeed } : { paused: false })
  const resumeLabel = `Resume at ${formatSpeed(resumeSpeed ?? 1)}`

  return (
    <div
      role="group"
      aria-label="Simulation"
      aria-describedby={notice ? descriptionId : undefined}
      aria-busy={control.isPending || undefined}
      className={cn("flex items-center gap-1", className)}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="icon-sm"
              disabled={readOnly}
              aria-label={paused ? "Resume simulation" : "Pause simulation"}
              onClick={() => (paused ? resume() : change({ paused: true }))}
            />
          }
        >
          {paused ? <PlayIcon /> : <PauseIcon />}
        </TooltipTrigger>
        <TooltipContent>{paused ? resumeLabel : "Pause"}</TooltipContent>
      </Tooltip>
      <ToggleGroup
        aria-label="Simulation speed"
        variant="outline"
        size="sm"
        spacing={0}
        disabled={readOnly}
        value={paused ? [] : [String(speed)]}
        onValueChange={(value) => {
          // Pressing the current speed again would clear the group: keep it.
          const next = Number(value[0])
          if (value.length > 0 && Number.isFinite(next)) change({ speed: next })
        }}
      >
        {SPEED_CHOICES.map((choice) => (
          <Tooltip key={choice.speed}>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value={String(choice.speed)}
                  aria-label={`${choice.label} ${choice.speed === MAX_SPEED ? "max " : ""}speed`}
                  className="tabular-nums"
                />
              }
            >
              {choice.label}
              {choice.speed === MAX_SPEED && (
                <span className="text-[0.7rem] font-normal text-muted-foreground">max</span>
              )}
            </TooltipTrigger>
            <TooltipContent className="max-w-64">{choice.description}</TooltipContent>
          </Tooltip>
        ))}
      </ToggleGroup>
      {notice && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size={notice.iconOnly ? "icon-sm" : "sm"}
                aria-label={notice.label}
                className={cn(!notice.iconOnly && "text-amber-700 dark:text-amber-400 max-xl:w-7 max-xl:px-0")}
              />
            }
          >
            <notice.icon />
            {!notice.iconOnly && <span className="max-xl:hidden">{notice.label}</span>}
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{notice.text}</TooltipContent>
        </Tooltip>
      )}
      {notice && (
        <span id={descriptionId} className="sr-only">
          {notice.text}
        </span>
      )}
    </div>
  )
}
