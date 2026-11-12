import {
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  LockIcon,
  PlugZapIcon,
  type LucideIcon,
} from "lucide-react"

import { Link } from "@tanstack/react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { APP_VERSION, type Connection, type ConnectionStatus } from "@/lib/connection"
import { useDesktop } from "@/lib/desktop"

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  checking: "Connecting",
  unreachable: "Bridge offline",
  unauthorized: "Token rejected",
  disabled: "AI requests off",
  loading: "Game loading",
  "no-city": "No city loaded",
  ready: "Connected",
}

export const STATUS_ICON: Record<ConnectionStatus, LucideIcon> = {
  checking: LoaderCircleIcon,
  unreachable: PlugZapIcon,
  unauthorized: CircleAlertIcon,
  disabled: CircleAlertIcon,
  loading: LoaderCircleIcon,
  "no-city": CircleAlertIcon,
  ready: CircleCheckIcon,
}

export function ConnectionBadge({ connection }: { connection: Connection }) {
  const Icon = STATUS_ICON[connection.status]
  const failing =
    connection.status === "unreachable" || connection.status === "unauthorized"
  return (
    <div className="flex items-center gap-1.5">
      {connection.readOnly && (
        <Badge variant="outline">
          <LockIcon data-icon="inline-start" />
          Read-only
        </Badge>
      )}
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant={failing ? "destructive" : connection.ready ? "secondary" : "outline"}
              role="status"
              aria-live="polite"
            />
          }
        >
          <Icon data-icon="inline-start" />
          {connection.ready && connection.state?.cityName
            ? connection.state.cityName
            : STATUS_LABEL[connection.status]}
        </TooltipTrigger>
        <TooltipContent>
          {STATUS_LABEL[connection.status]} · mod {connection.modVersion ?? "unknown"} ·
          companion {APP_VERSION}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

export const STATUS_HELP: Partial<Record<ConnectionStatus, { title: string; body: string }>> = {
  unreachable: {
    title: "Cannot reach the CS2 bridge",
    body: "Start Cities: Skylines II with the CS2MCP mod enabled. This page reconnects by itself.",
  },
  unauthorized: {
    title: "The bridge rejected the token",
    body: "CS2MCP_TOKEN for the web companion does not match the one set for the game. Fix it in the .env file and restart the companion.",
  },
  disabled: {
    title: "AI requests are switched off",
    body: "Turn on Accept AI requests in the game's Options > CS2MCP page.",
  },
  loading: {
    title: "The game is loading",
    body: "City data appears once the save has finished loading.",
  },
  "no-city": {
    title: "No city loaded",
    body: "Load a save in the game to see city data.",
  },
}

/** In the desktop app the bridge URL and token are set on the settings page, not in a .env file. */
const DESKTOP_STATUS_HELP: Partial<Record<ConnectionStatus, { title: string; body: string }>> = {
  unreachable: {
    title: "Cannot reach the CS2 bridge",
    body: "Start Cities: Skylines II with the CS2MCP mod enabled, or check the bridge URL in Settings. This page reconnects by itself.",
  },
  unauthorized: {
    title: "The bridge rejected the token",
    body: "The token this app sends does not match the one set for the game. Change it in Settings; no restart needed.",
  },
}

/** Explains why data is missing and what to do; nothing while connected or still checking. */
export function ConnectionAlerts({ connection }: { connection: Connection }) {
  const { isDesktop } = useDesktop()
  const desktopHelp = isDesktop ? DESKTOP_STATUS_HELP[connection.status] : undefined
  const help = desktopHelp ?? STATUS_HELP[connection.status]
  if (!help && !connection.versionMismatch) return null
  return (
    <div className="flex flex-col gap-2">
      {help && (
        <Alert
          variant={
            connection.status === "unreachable" || connection.status === "unauthorized"
              ? "destructive"
              : "default"
          }
        >
          <CircleAlertIcon />
          <AlertTitle>{help.title}</AlertTitle>
          <AlertDescription>
            {help.body}
            {connection.error && connection.status !== "unreachable" && (
              <span className="block font-mono text-xs">{connection.error}</span>
            )}
            {desktopHelp && (
              <Link to="/settings" hash="connection" className="block font-medium">
                Open connection settings
              </Link>
            )}
          </AlertDescription>
        </Alert>
      )}
      {connection.versionMismatch && (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>Version mismatch</AlertTitle>
          <AlertDescription>
            The game runs CS2MCP {connection.modVersion} but this web companion is {APP_VERSION}.
            Rebuild whichever is behind so both read the same data.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}
