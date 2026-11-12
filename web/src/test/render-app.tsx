import { createMemoryHistory } from "@tanstack/react-router"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { App } from "@/app"
import { createQueryClient } from "@/lib/queries"
import { createAppRouter } from "@/router"

/** Renders the whole app (real router and QueryClient) at `path`. */
export function renderApp(path = "/") {
  const user = userEvent.setup()
  const queryClient = createQueryClient()
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createAppRouter(queryClient, history)
  const view = render(<App router={router} queryClient={queryClient} />)
  return { ...view, user, router, queryClient }
}
