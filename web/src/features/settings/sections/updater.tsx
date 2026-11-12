import { CircleArrowUpIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { defineSettingsSection } from "@/features/settings/define-section"
import { SelectRow, SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"
import { formatDateTime } from "@/lib/format"
import { useUpdater, type UpdaterState } from "@/lib/updater"

const CHANNELS = [
  { value: "stable", label: "Stable releases" },
  { value: "beta", label: "Stable and beta releases" },
] as const

function statusText(state: UpdaterState) {
  switch (state.status) {
    case "unsupported":
      return state.unsupportedReason ?? "Updates are not available in this copy of the app."
    case "checking":
      return "Checking for updates…"
    case "available":
      return `Version ${state.availableVersion} is available.`
    case "downloading":
      return `Downloading version ${state.availableVersion} (${Math.round(state.progress?.percent ?? 0)}%)…`
    case "ready":
      return `Version ${state.availableVersion} is downloaded and installs when the app quits.`
    case "error":
      return `The last attempt failed: ${state.error ?? "unknown error"}`
    default:
      return `You are on the newest version (${state.currentVersion}).`
  }
}

function UpdaterSettings() {
  const autoCheck = useSetting("updater.autoCheck", true)
  const autoDownload = useSetting("updater.autoDownload", true)
  const channel = useSetting<"stable" | "beta">("updater.channel", "stable")
  const { state, action } = useUpdater()
  const unsupported = state?.status === "unsupported"
  const checking = state?.status === "checking" || (action.isPending && action.variables === "check")

  return (
    <FieldGroup>
      <SwitchRow
        setting={autoCheck}
        label="Check for updates automatically"
        description="Looks for a newer version shortly after start and every few hours."
        disabled={unsupported}
      />
      <SwitchRow
        setting={autoDownload}
        label="Download updates in the background"
        description="Otherwise you start the download yourself. A downloaded update installs when you quit the app."
        disabled={unsupported}
      />
      <SelectRow
        setting={channel}
        label="Releases"
        description="Beta releases are tested less; switching back to stable keeps the version you have until a newer stable one is out."
        options={CHANNELS}
        disabled={unsupported}
      />
      {state && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button
            variant="outline"
            disabled={unsupported || checking || state.status === "downloading"}
            onClick={() => action.mutate("check")}
          >
            {checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            Check now
          </Button>
          {state.status === "ready" && (
            <Button disabled={action.isPending} onClick={() => action.mutate("install")}>
              <CircleArrowUpIcon data-icon="inline-start" />
              Restart and install
            </Button>
          )}
          <p aria-live="polite" className="min-w-0 flex-1 text-muted-foreground">
            {statusText(state)}
            {state.lastCheck && !unsupported && <> Last checked {formatDateTime(state.lastCheck)}.</>}
          </p>
        </div>
      )}
      {action.isError && (
        <p role="alert" className="text-sm text-destructive">
          {action.error.message}
        </p>
      )}
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "updater",
  title: "Updates",
  description: "New versions of this app come from GitHub Releases.",
  icon: CircleArrowUpIcon,
  component: UpdaterSettings,
})
