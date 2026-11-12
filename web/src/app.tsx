import { QueryClientProvider, type QueryClient } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"

import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { createAppRouter } from "@/router"

export function App({
  router,
  queryClient,
}: {
  router: ReturnType<typeof createAppRouter>
  queryClient: QueryClient
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
