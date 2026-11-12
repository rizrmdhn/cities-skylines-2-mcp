/**
 * The first-run setup wizard (route /setup, rendered without the app header like the overlay):
 * Welcome → Game mod → Security → AI client → Done. Back / Next, skippable at any point. The
 * backend is the desktop app's `setup` feature (src/lib/setup.ts).
 */
import { useNavigate } from "@tanstack/react-router"
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, MonitorIcon } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { ClientStep, DoneStep, GameStep, SecurityStep, WelcomeStep } from "@/features/setup/setup-steps"
import { useDesktop } from "@/lib/desktop"
import { useSetupCompletion, useSetupStatus } from "@/lib/setup"
import { cn } from "@/lib/utils"

const STEPS = [
  { id: "welcome", title: "Welcome" },
  { id: "game", title: "Game mod" },
  { id: "security", title: "Security" },
  { id: "client", title: "AI client" },
  { id: "done", title: "Done" },
] as const

export function SetupWizard() {
  const { isDesktop, isPending } = useDesktop()
  if (isPending) return <Skeleton className="m-4 h-96" />
  if (!isDesktop) return <DesktopOnly />
  return <Wizard />
}

function Wizard() {
  const navigate = useNavigate()
  const [index, setIndex] = useState(0)
  const [share, setShare] = useState(false)
  const step = STEPS[index]
  // The game-mod step waits for the game to start, so it re-asks by itself.
  const status = useSetupStatus(step.id === "game")
  const { complete } = useSetupCompletion()
  const heading = useRef<HTMLHeadingElement>(null)
  const first = useRef(true)

  // Move focus to the new step's title so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    heading.current?.focus()
  }, [index])

  function finish() {
    complete.mutate(undefined, { onSuccess: () => void navigate({ to: "/", replace: true }) })
  }

  const last = index === STEPS.length - 1
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="font-heading text-lg font-semibold">CS2MCP Companion setup</h1>
        <Button variant="ghost" size="sm" className="ms-auto" onClick={finish} disabled={complete.isPending}>
          Skip setup
        </Button>
      </header>

      <nav aria-label="Setup steps">
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STEPS.map((item, position) => (
            <li
              key={item.id}
              aria-current={position === index ? "step" : undefined}
              className={cn("flex items-center gap-1.5", position === index ? "font-medium" : "text-muted-foreground")}
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-xs",
                  position === index && "border-primary bg-primary text-primary-foreground",
                  position < index && "border-primary text-primary"
                )}
              >
                {position < index ? <CheckIcon className="size-3" /> : position + 1}
              </span>
              <span>
                <span className="sr-only">Step {position + 1}: </span>
                {item.title}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2 ref={heading} tabIndex={-1} className="outline-none">
              {step.title}
            </h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step.id === "welcome" ? (
            <WelcomeStep />
          ) : status.isError ? (
            <QueryError title="Could not read the setup status" error={status.error} />
          ) : !status.data ? (
            <Skeleton className="h-48" />
          ) : step.id === "game" ? (
            <GameStep status={status.data} checking={status.isFetching} onCheck={() => void status.refetch()} />
          ) : step.id === "security" ? (
            <SecurityStep status={status.data} />
          ) : step.id === "client" ? (
            <ClientStep status={status.data} share={share} onShare={setShare} />
          ) : (
            <DoneStep status={status.data} />
          )}
        </CardContent>
        <CardFooter className="gap-2">
          <Button variant="outline" onClick={() => setIndex(index - 1)} disabled={index === 0}>
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
          {last ? (
            <Button className="ms-auto" onClick={finish} disabled={complete.isPending}>
              <CheckIcon data-icon="inline-start" />
              Finish
            </Button>
          ) : (
            <Button className="ms-auto" onClick={() => setIndex(index + 1)}>
              {step.id === "welcome" ? "Start" : "Next"}
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          )}
        </CardFooter>
      </Card>
      {complete.isError && <QueryError title="Could not save that setup is done" error={complete.error} />}
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
        <EmptyTitle>The setup wizard is part of the desktop app</EmptyTitle>
        <EmptyDescription>
          The CS2MCP Companion desktop app bundles the MCP server and can add it to your AI client for you. The browser companion is configured with its .env file.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
