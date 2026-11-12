import { createFileRoute, useLocation } from "@tanstack/react-router"
import { MonitorIcon } from "lucide-react"
import { useEffect } from "react"

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { AboutSection } from "@/features/settings/about-section"
import { AppearanceSection } from "@/features/settings/appearance-section"
import { ConnectionSection } from "@/features/settings/connection-section"
import { activeSettingsSections } from "@/features/settings/registry"
import { SettingsSection } from "@/features/settings/section-card"
import { useDesktop } from "@/lib/desktop"

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
})

function SettingsPage() {
  const { isDesktop, isPending, info } = useDesktop()
  const hash = useLocation({ select: (location) => location.hash })

  // The page appears after the desktop answer arrived, so a /settings#connection link scrolls late.
  useEffect(() => {
    if (hash && info) document.getElementById(hash)?.scrollIntoView?.()
  }, [hash, info])

  if (isPending) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-64" />
      </div>
    )
  }
  if (!isDesktop || !info) return <DesktopOnly />

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <h1 className="font-heading text-lg font-semibold">Settings</h1>
      <ConnectionSection />
      <AppearanceSection />
      {activeSettingsSections(info.features).map((section) => (
        <SettingsSection
          key={section.id}
          id={section.id}
          title={section.title}
          description={section.description}
          icon={section.icon}
        >
          <section.component />
        </SettingsSection>
      ))}
      <AboutSection />
    </div>
  )
}

function DesktopOnly() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MonitorIcon />
        </EmptyMedia>
        <EmptyTitle>Settings are available in the desktop app</EmptyTitle>
        <EmptyDescription>
          The browser companion reads the bridge URL and token from its .env file. In the CS2MCP
          Companion desktop app you can change them here without a restart.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
