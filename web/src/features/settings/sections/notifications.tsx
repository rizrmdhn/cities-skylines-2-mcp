import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BellIcon, BellRingIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldGroup, FieldLegend, FieldSet } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { defineSettingsSection } from "@/features/settings/define-section"
import { NumberRow, SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"
import { apiGet, apiPost } from "@/lib/api"

/** GET /api/desktop/notifications (the parts this card uses) */
interface NotificationLog {
  supported: boolean | null
  notifications: {
    id: number
    at: number
    kind: string
    title: string
    shown: boolean
    suppressed: string | null
  }[]
}

const LOG_KEY = ["desktop", "notifications"] as const

const SUPPRESSED_LABEL: Record<string, string> = {
  quiet: "quiet mode",
  focused: "window was focused",
  cooldown: "repeat",
  unsupported: "not supported",
  error: "system refused",
}

function RecentNotifications() {
  const log = useQuery({
    queryKey: LOG_KEY,
    queryFn: ({ signal }) => apiGet<NotificationLog>("/desktop/notifications", {}, signal),
    refetchInterval: 15_000,
  })
  const recent = log.data?.notifications.slice(0, 5) ?? []
  if (recent.length === 0) return null
  return (
    <FieldSet>
      <FieldLegend variant="label">Recent</FieldLegend>
      <ul aria-label="Recent notifications" className="flex flex-col gap-1.5 text-sm">
        {recent.map((item) => (
          <li key={item.id} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
              {new Date(item.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="min-w-0 flex-1 truncate" title={item.title}>
              {item.title}
            </span>
            {!item.shown && <Badge variant="ghost">{SUPPRESSED_LABEL[item.suppressed ?? ""] ?? "not shown"}</Badge>}
          </li>
        ))}
      </ul>
    </FieldSet>
  )
}

function TestButton() {
  const queryClient = useQueryClient()
  const test = useMutation({
    mutationFn: () => apiPost<{ shown: boolean }>("/desktop/notifications/test"),
    onSuccess: () => {
      toast.success("Test notification sent", {
        description: "If you do not see it, check Windows notification settings and Focus assist.",
      })
    },
    onError: (error) => toast.error("Could not send the notification", { description: error.message }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: LOG_KEY }),
  })
  return (
    <div>
      <Button variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
        {test.isPending ? <Spinner data-icon="inline-start" /> : <BellRingIcon data-icon="inline-start" />}
        Send test notification
      </Button>
    </div>
  )
}

function NotificationSettings() {
  const enabled = useSetting("notifications.enabled", true)
  const quiet = useSetting("notifications.quiet", false)
  const focused = useSetting("notifications.suppressWhenFocused", true)

  const connection = useSetting("notifications.connection", true)
  const cityLoaded = useSetting("notifications.cityLoaded", true)
  const warnings = useSetting("notifications.warnings", true)
  const aiActivity = useSetting("notifications.aiActivity", true)
  const aiFailures = useSetting("notifications.aiFailures", true)
  const spendingLimit = useSetting("notifications.spendingLimit", true)
  const forcedPause = useSetting("notifications.forcedPause", true)

  const warningThreshold = useSetting("notifications.warningThreshold", 10)
  const warningCooldown = useSetting("notifications.warningCooldownMinutes", 15)
  const limitPercent = useSetting("notifications.spendingLimitPercent", 20)
  const popupSeconds = useSetting("notifications.popupSeconds", 30)
  const connectionDelay = useSetting("notifications.connectionDelaySeconds", 20)

  const off = !enabled.value
  return (
    <FieldGroup>
      <SwitchRow
        setting={enabled}
        label="Show notifications"
        description="Windows notifications about the game and the AI. While they are off the companion sends no background requests for this."
      />
      <SwitchRow
        setting={quiet}
        label="Quiet mode (do not disturb)"
        description="Shows nothing and watches nothing until you turn it off again. The test button still works."
        disabled={off}
      />
      <SwitchRow
        setting={focused}
        label="Not while the companion is in front"
        description="You already see what is happening, so nothing is shown while the main window is focused."
        disabled={off}
      />

      <FieldSet>
        <FieldLegend variant="label">What to notify about</FieldLegend>
        <FieldGroup>
          <SwitchRow
            setting={connection}
            label="Game connection"
            description="The game became unreachable or reachable again. A change must last the delay below, so restarts and loading screens stay quiet."
            disabled={off}
          />
          <SwitchRow
            setting={cityLoaded}
            label="City loaded"
            description="A city finished loading and the AI can start."
            disabled={off}
          />
          <SwitchRow
            setting={warnings}
            label="New city warnings"
            description="A warning type appears or grows, for example buildings without electricity. Several at once are grouped in one notification."
            disabled={off}
          />
          <SwitchRow
            setting={aiActivity}
            label="AI activity"
            description="One summary after the AI finished a burst of changes: how many, what and how much it spent."
            disabled={off}
          />
          <SwitchRow
            setting={aiFailures}
            label="Failed AI actions"
            description="One notification per burst for the actions the game refused."
            disabled={off}
          />
          <SwitchRow
            setting={spendingLimit}
            label="AI spending limit"
            description="The limit on what the AI may spend is nearly used up, and again when it is."
            disabled={off}
          />
          <SwitchRow
            setting={forcedPause}
            label="Paused by a popup"
            description="The game waits for you to dismiss a popup, which blocks the AI."
            disabled={off}
          />
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend variant="label">Thresholds</FieldLegend>
        <FieldGroup>
          <NumberRow
            setting={warningThreshold}
            label="Warning count"
            description="Notify when a warning type reaches this many icons. Fires, disasters and collapsed buildings notify at one."
            min={1}
            max={100000}
            unit="icons"
            disabled={off || !warnings.value}
          />
          <NumberRow
            setting={warningCooldown}
            label="Warning cooldown"
            description="The same warning type is announced again only after this long, and only if it grew."
            min={1}
            max={1440}
            unit="minutes"
            disabled={off || !warnings.value}
          />
          <NumberRow
            setting={limitPercent}
            label="Spending limit warning"
            description="Notify when this share of the AI's spending limit is left."
            min={1}
            max={100}
            unit="% left"
            disabled={off || !spendingLimit.value}
          />
          <NumberRow
            setting={popupSeconds}
            label="Popup pause"
            description="Notify when a popup has held the game paused for this long."
            min={5}
            max={600}
            unit="seconds"
            disabled={off || !forcedPause.value}
          />
          <NumberRow
            setting={connectionDelay}
            label="Connection delay"
            description="A change of the connection or of the loaded city must last this long before it is announced."
            min={5}
            max={300}
            unit="seconds"
            disabled={off || (!connection.value && !cityLoaded.value)}
          />
        </FieldGroup>
      </FieldSet>

      <TestButton />
      <RecentNotifications />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "notifications",
  title: "Notifications",
  description: "Windows notifications about the connection, city warnings and what the AI does.",
  icon: BellIcon,
  component: NotificationSettings,
})
