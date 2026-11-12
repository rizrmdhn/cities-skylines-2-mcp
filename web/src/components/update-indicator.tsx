import { CircleArrowUpIcon, DownloadIcon, ExternalLinkIcon, RotateCwIcon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { formatBytes } from "@/lib/format"
import { hasPendingUpdate, useUpdater, type UpdaterState } from "@/lib/updater"
import { cn } from "@/lib/utils"

function summary(state: UpdaterState) {
  switch (state.status) {
    case "ready":
      return { label: "Restart to update", icon: RotateCwIcon, tone: "text-primary" }
    case "downloading":
      return {
        label: `Downloading ${Math.round(state.progress?.percent ?? 0)}%`,
        icon: DownloadIcon,
        tone: "text-primary",
      }
    case "error":
      return { label: "Update failed", icon: TriangleAlertIcon, tone: "text-destructive" }
    default:
      return { label: "Update available", icon: CircleArrowUpIcon, tone: "text-primary" }
  }
}

/**
 * Header button of the desktop app that appears when a newer version was found, is downloading or
 * is ready to install. Opens a small popover with the versions, the progress, the release notes
 * and the actions. Renders nothing in the browser companion, in a development run or when the
 * app is up to date.
 */
export function UpdateIndicator({ className }: { className?: string }) {
  const { state, action } = useUpdater()
  if (!hasPendingUpdate(state)) return null
  const { label, icon: Icon, tone } = summary(state)
  const busy = action.isPending
  const percent = Math.round(state.progress?.percent ?? 0)

  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="sm" className={cn("relative", className)} aria-label={label} />}
      >
        <Icon className={tone} data-icon="inline-start" />
        <span className="max-sm:sr-only">{label}</span>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-1">
          <PopoverTitle>
            {state.status === "ready" ? "Update ready to install" : `Version ${state.availableVersion} is available`}
          </PopoverTitle>
          <PopoverDescription>
            {state.status === "ready"
              ? "It installs when you quit the app, or restart now."
              : state.status === "downloading"
                ? "Downloading in the background."
                : state.status === "error"
                  ? "The download did not finish."
                  : state.autoDownload
                    ? "It downloads in the background."
                    : "Download it when you are ready."}
          </PopoverDescription>
        </div>

        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Installed</dt>
          <dd>{state.currentVersion}</dd>
          <dt className="text-muted-foreground">New</dt>
          <dd>{state.availableVersion}</dd>
        </dl>

        {state.status === "downloading" && (
          <Progress value={percent} aria-label="Download progress">
            <div className="flex w-full justify-between text-xs text-muted-foreground">
              <span>{percent}%</span>
              {state.progress && state.progress.total > 0 && (
                <span>
                  {formatBytes(state.progress.transferred)} of {formatBytes(state.progress.total)}
                </span>
              )}
            </div>
          </Progress>
        )}

        {state.status === "error" && state.error && (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        )}
        {action.isError && (
          <p role="alert" className="text-destructive">
            {action.error.message}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {state.status === "ready" && (
            <Button size="sm" disabled={busy} onClick={() => action.mutate("install")}>
              {busy ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
              Restart and install
            </Button>
          )}
          {(state.status === "available" || state.status === "error") && (
            <Button size="sm" disabled={busy} onClick={() => action.mutate("download")}>
              {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
              {state.status === "error" ? "Try again" : "Download"}
            </Button>
          )}
          {state.releaseNotesUrl && (
            <a
              href={state.releaseNotesUrl}
              target="_blank"
              rel="noreferrer"
              className="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              Release notes
              <ExternalLinkIcon className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
