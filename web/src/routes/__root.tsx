import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router"
import { ActivityIcon, ChartLineIcon, LayoutDashboardIcon, MapIcon, SettingsIcon, type LucideIcon } from "lucide-react"

import { ConnectionAlerts, ConnectionBadge } from "@/components/connection-status"
import { SimControls } from "@/components/sim-controls"
import { ThemeToggle } from "@/components/theme-toggle"
import { UpdateIndicator } from "@/components/update-indicator"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { OverlayButton } from "@/features/overlay/overlay-button"
import { FirstRunRedirect } from "@/features/setup/first-run-redirect"
import { useConnection } from "@/lib/connection"
import { useDesktop } from "@/lib/desktop"
import type { RouterContext } from "@/router"

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
})

const NAV: { to: "/" | "/activity" | "/map" | "/trends"; label: string; icon: LucideIcon; desktopOnly?: boolean }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { to: "/activity", label: "AI activity", icon: ActivityIcon },
  { to: "/map", label: "Map", icon: MapIcon },
  { to: "/trends", label: "Trends", icon: ChartLineIcon, desktopOnly: true },
]

/** Pages that exist only in the desktop app. */
const DESKTOP_NAV: { to: "/settings"; label: string; icon: LucideIcon }[] = [
  { to: "/settings", label: "Settings", icon: SettingsIcon },
]

function NavLinks() {
  const matchRoute = useMatchRoute()
  const { isDesktop } = useDesktop()
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {[...NAV.filter((item) => isDesktop || !item.desktopOnly), ...(isDesktop ? DESKTOP_NAV : [])].map(({ to, label, icon: Icon }) => {
        const active = Boolean(matchRoute({ to }))
        return (
          <Link
            key={to}
            to={to}
            aria-current={active ? "page" : undefined}
            className={buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" })}
          >
            <Icon data-icon="inline-start" />
            <span className="max-sm:sr-only">{label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

/** Routes that fill a window of their own and must not get the app header and connection alerts. */
const BARE_ROUTES = ["/overlay", "/setup"] as const

function RootLayout() {
  const matchRoute = useMatchRoute()
  const bare = BARE_ROUTES.some((to) => matchRoute({ to }))
  return (
    <>
      <FirstRunRedirect />
      {bare ? <Outlet /> : <AppShell />}
    </>
  )
}

function AppShell() {
  const connection = useConnection()
  return (
    <div className="flex h-svh flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <span className="font-heading text-sm font-semibold max-md:hidden">CS2MCP</span>
        <NavLinks />
        <SimControls connection={connection} className="max-sm:order-last max-sm:w-full" />
        <div className="ms-auto flex items-center gap-2">
          <OverlayButton />
          <UpdateIndicator />
          <ConnectionBadge connection={connection} />
          <ThemeToggle />
        </div>
      </header>
      {(connection.status !== "ready" || connection.versionMismatch) && (
        <div className="px-4 pt-3 empty:hidden">
          <ConnectionAlerts connection={connection} />
        </div>
      )}
      <main className="flex min-h-0 flex-1 flex-col overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}

function NotFound() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Page not found</EmptyTitle>
        <EmptyDescription>
          <Link to="/">Back to the dashboard</Link>
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
