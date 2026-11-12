import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { App } from "@/app"
import { createQueryClient } from "@/lib/queries"
import { createAppRouter } from "@/router"

const queryClient = createQueryClient()
const router = createAppRouter(queryClient)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>
)
