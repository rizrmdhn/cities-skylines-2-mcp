import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ConfirmClear } from "@/features/trends/confirm-clear"
import { formatTime } from "@/lib/format"
import {
  clearTrends,
  setTrendsSetting,
  trendsQueryKeys,
  type TrendCity,
  type TrendsStatus,
} from "@/lib/trends"

const INTERVALS = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 120, label: "2 minutes" },
  { value: 300, label: "5 minutes" },
  { value: 600, label: "10 minutes" },
]

function stateText(status: TrendsStatus): { label: string; detail: string; tone: "default" | "secondary" | "destructive" | "outline" } {
  switch (status.state) {
    case "recording":
      return { label: "Recording", detail: status.city ? `Saving ${status.city.name}` : "", tone: "default" }
    case "paused":
      return { label: "Game paused", detail: "Nothing is recorded while game time stands still.", tone: "secondary" }
    case "no-city":
      return { label: "Waiting for a city", detail: "Recording starts when a city is loaded.", tone: "secondary" }
    case "unreachable":
      return { label: "Game not reachable", detail: "Trying again with growing pauses.", tone: "outline" }
    case "error":
      return { label: "Bridge error", detail: status.error ?? "", tone: "destructive" }
    case "disabled":
      return { label: "Recording is off", detail: "Switch it on to keep a history.", tone: "outline" }
    default:
      return { label: "Starting", detail: "", tone: "secondary" }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Recorder status, the recording switch, the sampling interval and "Clear data". */
export function RecorderCard({
  status,
  city,
  cityCount,
}: {
  status: TrendsStatus
  /** The city shown on the page, with its history; null when it has none. */
  city: TrendCity | null
  cityCount: number
}) {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: trendsQueryKeys.all })
  const setSetting = useMutation({
    mutationFn: (change: { key: "trends.enabled" | "trends.intervalSeconds"; value: boolean | number }) =>
      setTrendsSetting(change.key, change.value),
    onSuccess: refresh,
    onError: (error: Error) => toast.error(`Could not change the setting: ${error.message}`),
  })
  const clear = useMutation({
    mutationFn: (target: "city" | "all") => clearTrends(target === "all" || !city ? { all: true } : { city: city.key }),
    onSuccess: (_answer, target) => {
      toast.success(target === "all" || !city ? "Trend history deleted" : `Trend history of ${city.name} deleted`)
      void refresh()
    },
    onError: (error: Error) => toast.error(`Could not delete the history: ${error.message}`),
  })

  const state = stateText(status)
  const intervals = INTERVALS.some((entry) => entry.value === status.intervalSeconds)
    ? INTERVALS
    : [...INTERVALS, { value: status.intervalSeconds, label: `${status.intervalSeconds} seconds` }].sort((a, b) => a.value - b.value)

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex min-w-0 items-center gap-2" data-testid="recorder-status">
            <Badge variant={state.tone}>{state.label}</Badge>
            <span className="truncate text-sm text-muted-foreground">
              {state.detail}
              {status.lastSampleAt !== null && status.state === "recording"
                ? ` Last sample ${formatTime(new Date(status.lastSampleAt).toISOString())}.`
                : ""}
            </span>
          </div>
          <div className="ms-auto flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={status.enabled}
                disabled={setSetting.isPending}
                onCheckedChange={(value) => setSetting.mutate({ key: "trends.enabled", value })}
                aria-label="Record history"
              />
              Record history
            </label>
            <Select
              items={intervals.map((entry) => ({ value: entry.value, label: `Every ${entry.label}` }))}
              value={status.intervalSeconds}
              onValueChange={(value) => {
                if (typeof value === "number") setSetting.mutate({ key: "trends.intervalSeconds", value })
              }}
            >
              <SelectTrigger size="sm" aria-label="Sampling interval" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {intervals.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      Every {entry.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <ConfirmClear
              city={city && city.samples > 0 ? { name: city.name, samples: city.samples } : null}
              cityCount={cityCount}
              pending={clear.isPending}
              onClear={(target) => clear.mutate(target)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {formatBytes(status.bytes)} on disk. Keeps{" "}
          {status.retentionDays > 0 ? `${status.retentionDays} days` : "everything"}, at most{" "}
          {status.maxSamplesPerCity.toLocaleString("en-US")} samples per city (older samples get sparser). The
          history stays on this computer.
        </p>
      </CardContent>
    </Card>
  )
}
