import {
  createRootRouteWithContext,
  Link,
  Outlet,
  useMatchRoute,
} from "@tanstack/react-router"
import { ActivityIcon, LayoutDashboardIcon, MapIcon, SettingsIcon, type LucideIcon } from "lucide-react"

import { ConnectionAlerts, ConnectionBadge } from "@/components/connection-status"
import { ThemeToggle } from "@/components/theme-toggle"
import { buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { useConnection } from "@/lib/connection"
import { useDesktop } from "@/lib/desktop"
import type { RouterContext } from "@/router"

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFound,
})

const NAV: { to: "/" | "/activity" | "/map"; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboardIcon },
  { to: "/activity", label: "AI activity", icon: ActivityIcon },
  { to: "/map", label: "Map", icon: MapIcon },
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
      {(isDesktop ? [...NAV, ...DESKTOP_NAV] : NAV).map(({ to, label, icon: Icon }) => {
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

function RootLayout() {
  const connection = useConnection()
  return (
    <div className="flex h-svh flex-col">
      <header className="flex items-center gap-3 border-b px-4 py-2">
        <span className="font-heading text-sm font-semibold max-md:hidden">CS2MCP</span>
        <NavLinks />
        <div className="ms-auto flex items-center gap-2">
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
