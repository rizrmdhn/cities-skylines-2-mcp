import { useMutation, useQuery } from "@tanstack/react-query"
import { FolderOpenIcon, InfoIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { SettingsSection } from "@/features/settings/section-card"
import { apiGet, apiPost } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"
import { pingQuery } from "@/lib/queries"

const PLATFORM_NAME: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
}

interface AppFolders {
  logs: string
  settings: string
}

const APP_FOLDERS_FEATURE = "app-folders"

/** App and mod versions, platform, build kind, active desktop features and the two folders. */
export function AboutSection() {
  const { info } = useDesktop()
  const ping = useQuery(pingQuery())
  const hasFolders = info?.features.includes(APP_FOLDERS_FEATURE) ?? false
  const folders = useQuery({
    queryKey: ["desktop", "app-folders"],
    queryFn: ({ signal }) => apiGet<AppFolders>("/desktop/app-folders", {}, signal),
    enabled: hasFolders,
    staleTime: Infinity,
  })
  const open = useMutation({
    mutationFn: (which: "logs" | "settings") => apiPost(`/desktop/app-folders/open-${which}`),
  })

  if (!info) return null
  const modVersion = ping.data?.version ?? (ping.isError ? "not connected" : "…")
  return (
    <SettingsSection id="about" title="About" icon={InfoIcon}>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">App version</dt>
        <dd>{info.version}</dd>
        <dt className="text-muted-foreground">Mod version</dt>
        <dd>{modVersion}</dd>
        <dt className="text-muted-foreground">Platform</dt>
        <dd>{PLATFORM_NAME[info.platform] ?? info.platform}</dd>
        <dt className="text-muted-foreground">Build</dt>
        <dd>{info.packaged ? "Packaged" : "Development"}</dd>
        <dt className="text-muted-foreground">Features</dt>
        <dd>
          <ul aria-label="Active desktop features" className="flex flex-wrap gap-1.5">
            {info.features.map((feature) => (
              <li key={feature}>
                <Badge variant="outline" className="font-mono">
                  {feature}
                </Badge>
              </li>
            ))}
          </ul>
        </dd>
        {folders.data && (
          <>
            <dt className="text-muted-foreground">Log folder</dt>
            <dd className="font-mono text-xs break-all">{folders.data.logs}</dd>
            <dt className="text-muted-foreground">Settings folder</dt>
            <dd className="font-mono text-xs break-all">{folders.data.settings}</dd>
          </>
        )}
      </dl>
      {hasFolders && (
        <div className="mt-6 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={open.isPending} onClick={() => open.mutate("logs")}>
              {open.isPending && open.variables === "logs" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FolderOpenIcon data-icon="inline-start" />
              )}
              Open log folder
            </Button>
            <Button variant="outline" disabled={open.isPending} onClick={() => open.mutate("settings")}>
              {open.isPending && open.variables === "settings" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FolderOpenIcon data-icon="inline-start" />
              )}
              Open settings folder
            </Button>
          </div>
          <FieldError>{open.error?.message}</FieldError>
        </div>
      )}
    </SettingsSection>
  )
}
