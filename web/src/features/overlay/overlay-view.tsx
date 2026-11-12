import { useMutation, useQuery } from "@tanstack/react-query"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MinusIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import { STATUS_ICON, STATUS_LABEL } from "@/components/connection-status"
import { SimControls } from "@/components/sim-controls"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useActivity } from "@/features/activity/use-activity"
import { useTrend, type Trend } from "@/features/overlay/use-trend"
import { apiPost } from "@/lib/api"
import type { Demand } from "@/lib/bridge-types"
import { useConnection, type Connection, type ConnectionStatus } from "@/lib/connection"
import { useDesktop } from "@/lib/desktop"
import { actionLabel, formatMoney, formatMoneyDelta, formatNumber, formatTime } from "@/lib/format"
import { demandQuery, notificationsQuery, overviewQuery } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * The page of the overlay window (desktop/src/features/overlay.ts): a frameless window of about
 * 340 x 210 px that sits above the game. The whole surface drags the window; everything you can
 * click opts out. The polling matches the dashboard (overview 5 s, demand and warnings 15 s,
 * AI history 5 s). The window itself is made translucent by the desktop app (overlay.opacity).
 */
const DRAG = "[-webkit-app-region:drag]"
const NO_DRAG = "[-webkit-app-region:no-drag]"

/** The game's building demand runs 0-255. */
const DEMAND_MAX = 255

const OFFLINE_HINT: Record<Exclude<ConnectionStatus, "ready">, string> = {
  checking: "Looking for the game…",
  unreachable: "Start Cities: Skylines II with the CS2MCP mod.",
  unauthorized: "The bridge rejected the token. Check it under Settings.",
  disabled: "AI requests are turned off in the game's CS2MCP options.",
  loading: "The city data appears once loading is done.",
  "no-city": "Load or start a city in the game.",
}

export function OverlayView() {
  const connection = useConnection()
  const { isDesktop } = useDesktop()
  const overview = useQuery({ ...overviewQuery(), enabled: connection.ready })
  const city = overview.data

  const close = useMutation({ mutationFn: () => apiPost("/desktop/overlay/hide") })

  return (
    // The 5 px frame around the content is not draggable: that is where the window resize handles are.
    <div className="h-svh border border-border bg-background p-[5px] text-foreground">
      <div className={cn("flex h-full flex-col gap-1.5 overflow-hidden select-none", DRAG)}>
        <header className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            {connection.ready && city ? (
              <>
                <h1 className="truncate text-sm font-semibold">{city.cityName || "Unnamed city"}</h1>
                <span className="truncate text-xs text-muted-foreground">{city.gameDateTime ?? ""}</span>
              </>
            ) : connection.ready ? (
              <Skeleton className="h-4 w-28" />
            ) : (
              <h1 className="truncate text-sm font-semibold">CS2MCP</h1>
            )}
          </div>
          {isDesktop && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close overlay"
              title="Close overlay"
              className={NO_DRAG}
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              <XIcon />
            </Button>
          )}
        </header>
        {connection.status === "ready" ? <CityBody connection={connection} /> : <Offline status={connection.status} />}
      </div>
    </div>
  )
}

function CityBody({ connection }: { connection: Connection }) {
  const overview = useQuery(overviewQuery())
  const demand = useQuery(demandQuery())
  const notifications = useQuery(notificationsQuery())
  const { sessions } = useActivity()
  const city = overview.data
  const moneyTrend = useTrend(city?.money, city?.cityName ?? "")
  const latest = sessions?.[0]?.steps.at(-1)
  const warnings = notifications.data?.total

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Money" trend={city ? moneyTrend : undefined}>
          {city ? formatMoney(city.money, { compact: true }) : undefined}
        </Stat>
        <Stat label="Population">{city ? formatNumber(city.population) : undefined}</Stat>
      </div>

      <DemandBars demand={demand.data} />

      <div className="flex min-w-0 items-center gap-3 text-xs">
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 tabular-nums",
            warnings ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
          )}
          title={warnings === undefined ? "Warnings" : `${formatNumber(warnings)} warning icons in the city`}
        >
          <TriangleAlertIcon className="size-3.5" aria-hidden />
          <span className="sr-only">Warnings:</span>
          {warnings === undefined ? "–" : formatNumber(warnings)}
        </span>
        <span
          className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground"
          title={latest ? `${actionLabel(latest.path)} at ${formatTime(new Date(latest.startMs).toISOString())}` : undefined}
        >
          <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="sr-only">Latest AI action:</span>
          {latest ? (
            <span className="min-w-0 truncate">
              <span className={cn("capitalize", !latest.ok && "text-destructive")}>{actionLabel(latest.path)}</span>
              {!latest.ok && " failed"}
              {latest.ok && latest.moneyDelta !== 0 && ` · ${formatMoneyDelta(latest.moneyDelta)}`}
              {` · ${formatTime(new Date(latest.startMs).toISOString())}`}
            </span>
          ) : (
            <span className="truncate">{sessions ? "No AI actions yet" : "…"}</span>
          )}
        </span>
      </div>

      <div className={cn("mt-auto", NO_DRAG)}>
        <SimControls connection={connection} />
      </div>
    </>
  )
}

const TREND_ICON: Record<Trend, LucideIcon> = { up: ArrowUpIcon, down: ArrowDownIcon, flat: MinusIcon }
const TREND_TEXT: Record<Trend, string> = { up: "rising", down: "falling", flat: "steady" }

function Stat({ label, trend, children }: { label: string; trend?: Trend; children: string | undefined }) {
  const Icon = trend ? TREND_ICON[trend] : undefined
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[0.7rem] leading-4 text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1 text-base leading-5 font-semibold tabular-nums">
        {children === undefined ? <Skeleton className="h-4 w-20" /> : <span className="truncate">{children}</span>}
        {Icon && trend && (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  className={cn(
                    "inline-flex",
                    trend === "up" && "text-emerald-600 dark:text-emerald-400",
                    trend === "down" && "text-red-600 dark:text-red-400",
                    trend === "flat" && "text-muted-foreground"
                  )}
                />
              }
            >
              <Icon className="size-3.5" aria-hidden />
              <span className="sr-only">
                {label} {TREND_TEXT[trend]}
              </span>
            </TooltipTrigger>
            <TooltipContent>{label} is {TREND_TEXT[trend]}</TooltipContent>
          </Tooltip>
        )}
      </span>
    </div>
  )
}

function DemandBars({ demand }: { demand: Demand | undefined }) {
  const residential = demand
    ? Math.max(
        demand.residential.buildingDemand.lowDensity,
        demand.residential.buildingDemand.mediumDensity,
        demand.residential.buildingDemand.highDensity
      )
    : undefined
  return (
    <div role="group" aria-label="Zone demand" className="grid grid-cols-3 gap-3">
      <DemandBar short="Res" name="Residential" value={residential} fill="bg-emerald-500" note="highest density" />
      <DemandBar short="Com" name="Commercial" value={demand?.commercial.buildingDemand} fill="bg-sky-500" />
      <DemandBar short="Ind" name="Industrial" value={demand?.industrial.buildingDemand} fill="bg-amber-500" />
    </div>
  )
}

function DemandBar({
  short,
  name,
  value,
  fill,
  note,
}: {
  short: string
  name: string
  value: number | undefined
  fill: string
  note?: string
}) {
  const percent = value === undefined ? 0 : Math.min(100, (Math.max(0, value) / DEMAND_MAX) * 100)
  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      title={value === undefined ? `${name} demand` : `${name} demand ${value} of ${DEMAND_MAX}${note ? ` (${note})` : ""}`}
    >
      <div className="flex items-baseline justify-between gap-1 text-[0.7rem] leading-none text-muted-foreground">
        <span aria-hidden>{short}</span>
        <span className="tabular-nums">{value ?? "–"}</span>
      </div>
      <div
        role="meter"
        aria-label={`${name} demand`}
        aria-valuemin={0}
        aria-valuemax={DEMAND_MAX}
        aria-valuenow={value}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn("h-full rounded-full transition-[width]", fill)} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function Offline({ status }: { status: Exclude<ConnectionStatus, "ready"> }) {
  const Icon = STATUS_ICON[status]
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-1 px-2 text-center">
      <Icon
        className={cn(
          "size-5 text-muted-foreground",
          (status === "checking" || status === "loading") && "animate-spin"
        )}
        aria-hidden
      />
      <p className="text-sm font-medium">{STATUS_LABEL[status]}</p>
      <p className="text-xs text-muted-foreground">{OFFLINE_HINT[status]}</p>
    </div>
  )
}
