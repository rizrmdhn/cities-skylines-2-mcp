/**
 * The five steps of the first-run wizard (Welcome, Game mod, Security, AI client, Done). Each step
 * is a plain component over the status the `setup` desktop feature reports; the shell
 * (setup-wizard.tsx) owns navigation and the "share my settings" choice.
 */
import {
  BotIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  KeyRoundIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useId, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  useSetupAction,
  type RegisterResult,
  type SetupClient,
  type SetupSnippet,
  type SetupStatus,
  type SnippetTarget,
} from "@/lib/setup"

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Inline monospace text. */
function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8rem] break-all">{children}</code>
}

function Pre({ children, label }: { children: ReactNode; label: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label={label}
      className="max-h-48 overflow-auto rounded-lg border bg-muted/50 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all"
    >
      {children}
    </pre>
  )
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-sm">{children}</ol>
}

function Problem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

function Good({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Alert>
      <CircleCheckIcon className="text-emerald-600 dark:text-emerald-400" />
      <AlertTitle>{title}</AlertTitle>
      {children && <AlertDescription>{children}</AlertDescription>}
    </Alert>
  )
}

function Note({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Alert>
      <TriangleAlertIcon className="text-amber-600 dark:text-amber-400" />
      <AlertTitle>{title}</AlertTitle>
      {children && <AlertDescription>{children}</AlertDescription>}
    </Alert>
  )
}

async function copyPlain(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error("Could not copy. Select the text and copy it by hand.")
  }
}

// ---------------------------------------------------------------------------------------------

export function WelcomeStep() {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        This takes about two minutes and gets an AI assistant (Claude, Cursor, …) ready to read and run your Cities: Skylines II city.
        Nothing is changed until you press a button for it.
      </p>
      <ol className="flex flex-col gap-2">
        <li>
          <strong>Game mod</strong> – check that the CS2MCP mod in the game answers.
        </li>
        <li>
          <strong>Security</strong> – optionally lock the mod with a secret only your programs know.
        </li>
        <li>
          <strong>AI client</strong> – add this app's built-in MCP server to the AI app you use. No Node.js needed.
        </li>
      </ol>
      <p className="text-muted-foreground">
        You can skip any step and run the setup again later from Settings.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

export function GameStep({ status, onCheck, checking }: { status: SetupStatus; onCheck: () => void; checking: boolean }) {
  const { bridge } = status
  return (
    <div className="flex flex-col gap-4 text-sm" aria-live="polite">
      {bridge.link === "ready" && (
        <Good title={`Connected to ${bridge.city ?? "your city"}`}>
          CS2MCP mod {bridge.modVersion} answers at <Code>{bridge.url}</Code>
          {bridge.readOnly && " (read-only mode: the AI can look but not change anything)"}.
        </Good>
      )}
      {(bridge.link === "no-city" || bridge.link === "loading") && (
        <Good title={bridge.link === "loading" ? "The game is still loading" : "Connected – no city loaded yet"}>
          The mod {bridge.modVersion} answers at <Code>{bridge.url}</Code>. AI requests about the city work once a save is loaded.
        </Good>
      )}
      {bridge.link === "disabled" && (
        <Note title="The mod is installed, but it is switched off">
          In the game open <strong>Options → CS2MCP (AI bridge) → Main</strong> and turn on <strong>Accept AI requests</strong>. This page notices by itself.
        </Note>
      )}
      {bridge.link === "unauthorized" && (
        <Note title="The mod rejected this app's token">
          The game was started with a different <Code>CS2MCP_TOKEN</Code> than the one saved here. The next step, Security, shows how to make them match.
        </Note>
      )}
      {bridge.link === "unreachable" && (
        <>
          <Note title="The mod does not answer at the moment">
            Nothing is listening at <Code>{bridge.url}</Code>
            {bridge.error ? ` (${bridge.error})` : ""}. That is normal until the game runs with the mod.
          </Note>
          <Steps>
            <li>
              Install the CS2MCP mod. It lives in{" "}
              <Code>%USERPROFILE%\AppData\LocalLow\Colossal Order\Cities Skylines II\Mods\CS2MCP\</Code> and loads on its own when the game starts (the project README explains how to build and deploy it).
            </li>
            <li>Start Cities: Skylines II.</li>
            <li>
              In the game open <strong>Options → CS2MCP (AI bridge) → Main</strong> and make sure <strong>Accept AI requests</strong> is on.
            </li>
            <li>Come back here; this page checks every few seconds. You can also continue now and finish this later.</li>
          </Steps>
          <p className="text-muted-foreground">
            Using another port or computer? Change the bridge URL in Settings → Connection (the game's port is set with the <Code>CS2MCP_PORT</Code> environment variable).
          </p>
        </>
      )}
      {bridge.versionMismatch && (
        <Note title="Version mismatch">
          The mod is {bridge.modVersion}, this app is {bridge.appVersion}. Rebuild and redeploy both from the same version.
        </Note>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
          {checking ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          Check again
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

const GAME_TOKEN_TEXT = {
  matches: "The Windows user variable CS2MCP_TOKEN already holds this token.",
  different: "The Windows user variable CS2MCP_TOKEN holds a different value than the token saved here.",
  unset: "The Windows user variable CS2MCP_TOKEN is not set yet.",
  set: "The Windows user variable CS2MCP_TOKEN is set.",
  unknown: "Could not read the Windows user variable CS2MCP_TOKEN.",
  unsupported: "",
} as const

export function SecurityStep({ status }: { status: SetupStatus }) {
  const consentId = useId()
  const { token } = status
  const generate = useSetupAction<{ replace: boolean }, unknown>("token/generate")
  const copy = useSetupAction<{ as: "token" | "setx" }, unknown>("token/copy")
  const setGame = useSetupAction<{ confirm: true }, { restart: string }>("game-token")
  const [consent, setConsent] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const windows = token.gameEnv.supported

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        By default any program on this PC can talk to the mod (websites cannot). A token is a secret the game, this app and your AI client all know, so only they can. <strong>It is optional</strong>; if you play alone on your own PC you can skip it.
      </p>

      {!token.set && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => generate.mutate({ replace: false })} disabled={generate.isPending}>
            {generate.isPending ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
            Generate a token
          </Button>
          <span className="text-muted-foreground">or skip to continue without one.</span>
        </div>
      )}

      {token.set && (
        <>
          <Good title="A token is set">
            Saved in this app{token.secretsEncrypted ? ", encrypted with your Windows account" : " (this system has no key store, so it is saved as plain text)"}
            {token.source !== "settings" && ` – it comes from ${token.source === "env" ? "this app's environment" : token.source === "dotenv" ? "a .env file" : token.source}`}. It is never shown on screen.
          </Good>
          <section className="flex flex-col gap-3" aria-label="Give the game the same token">
            <h3 className="font-medium">Give the game the same token</h3>
            <p className="text-muted-foreground">
              The game reads the token from its environment variable <Code>CS2MCP_TOKEN</Code>. Steam and the Paradox launcher start the game with the environment <em>they</em> were started with, so the variable must exist before the launcher starts.
            </p>
            {windows && token.gameEnv.state !== "unsupported" && (
              <p aria-live="polite">
                {GAME_TOKEN_TEXT[token.gameEnv.state]}
                {token.gameEnv.state === "matches" && " Restart Steam if the game was already running."}
              </p>
            )}
            <Steps>
              <li>
                Set the variable for your Windows account: press <strong>Set it for me</strong> below, or copy the command and run it in PowerShell.
              </li>
              <li>Quit Steam (and the Paradox launcher) completely – right-click its tray icon → Exit.</li>
              <li>Start Steam again, then Cities: Skylines II. The connection badge in this app's header turns green when both agree.</li>
            </Steps>
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={consentId}>Let this app set the variable</FieldLabel>
                  <FieldDescription>
                    Runs one PowerShell command that sets <Code>CS2MCP_TOKEN</Code> in your Windows user environment (your account only, no admin rights). You can delete it later in Windows → Environment Variables.
                  </FieldDescription>
                </FieldContent>
                <Switch id={consentId} checked={consent} onCheckedChange={setConsent} disabled={!windows} />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!consent || !windows || setGame.isPending}
                  onClick={() => setGame.mutate({ confirm: true })}
                >
                  {setGame.isPending && <Spinner data-icon="inline-start" />}
                  Set it for me
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    copy.mutate(
                      { as: "setx" },
                      { onSuccess: () => toast.success("Command copied – paste it into PowerShell"), onError: (e) => toast.error(errorText(e)) }
                    )
                  }
                >
                  <CopyIcon data-icon="inline-start" />
                  Copy the setx command
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    copy.mutate(
                      { as: "token" },
                      { onSuccess: () => toast.success("Token copied"), onError: (e) => toast.error(errorText(e)) }
                    )
                  }
                >
                  <CopyIcon data-icon="inline-start" />
                  Copy the token
                </Button>
              </div>
              {setGame.isSuccess && <Good title="Variable set">{setGame.data.restart}</Good>}
              {setGame.isError && <Problem title="Could not set the variable">{errorText(setGame.error)}</Problem>}
              {copy.isError && <Problem title="Could not copy">{errorText(copy.error)}</Problem>}
              <p className="text-muted-foreground">
                The clipboard keeps the token until you copy something else. It also works with <Code>setx CS2MCP_TOKEN "…"</Code> typed in a command prompt, or any other way you set user environment variables.
              </p>
            </div>
          </section>

          {token.source !== "env" && (
            <div className="flex flex-wrap items-center gap-2">
              {!confirmNew ? (
                <Button variant="ghost" size="sm" onClick={() => setConfirmNew(true)}>
                  Replace with a new token…
                </Button>
              ) : (
                <>
                  <span className="text-muted-foreground">The game and every AI client must then be given the new value.</span>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={generate.isPending}
                    onClick={() => generate.mutate({ replace: true }, { onSuccess: () => setConfirmNew(false) })}
                  >
                    Yes, generate a new token
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmNew(false)}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
          )}
          {token.source === "env" && (
            <p className="text-muted-foreground">
              The token comes from this app's environment variable, which wins over anything saved; to use a generated one, remove that variable first.
            </p>
          )}
        </>
      )}

      {generate.isError && <Problem title="Could not generate a token">{errorText(generate.error)}</Problem>}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------

const STATE_BADGE: Record<SetupClient["state"], { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  current: { label: "Set up", variant: "default" },
  outdated: { label: "Needs update", variant: "secondary" },
  none: { label: "Not set up", variant: "outline" },
  unreadable: { label: "Config unreadable", variant: "destructive" },
}

export function ClientStep({
  status,
  share,
  onShare,
}: {
  status: SetupStatus
  share: boolean
  onShare: (value: boolean) => void
}) {
  const shareId = useId()
  const { server, token } = status
  const [last, setLast] = useState<RegisterResult | null>(null)
  const register = useSetupAction<{ client: string; shareSettings: boolean }, RegisterResult>("register")
  const unregister = useSetupAction<{ client: string }, RegisterResult>("unregister")
  const snippet = useSetupAction<{ target: SnippetTarget; shareSettings: boolean; copy: boolean }, SetupSnippet>("snippet")
  const [target, setTarget] = useState<SnippetTarget>("json")
  const busy = register.isPending || unregister.isPending
  const urlDiffers = status.bridge.url !== "http://127.0.0.1:8642"
  const canShare = token.set || urlDiffers

  const detected = status.clients.filter((client) => client.detected)
  const missing = status.clients.filter((client) => !client.detected)

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>
        This app contains the MCP server, so the AI client does not need Node.js: it starts <Code>{server.command}</Code> with the environment variable <Code>ELECTRON_RUN_AS_NODE=1</Code> and the bundled server file as its argument.
      </p>
      {!server.found && <Problem title="The bundled MCP server file is missing">{server.problem}</Problem>}

      {canShare && (
        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor={shareId}>Put my {token.set ? "token" : "bridge URL"}{token.set && urlDiffers ? " and bridge URL" : ""} into the client's settings</FieldLabel>
            <FieldDescription>
              {token.set ? (
                <>
                  Needed: the game rejects requests without the token. The token is then stored <strong>in plain text</strong> in the AI client's config file (readable by every program you run). Leave this off to add the token to the client yourself.
                </>
              ) : (
                <>Your bridge URL differs from the default; the client needs it to find the game. It is not a secret.</>
              )}
            </FieldDescription>
          </FieldContent>
          <Switch id={shareId} checked={share} onCheckedChange={onShare} />
        </Field>
      )}
      {token.set && !share && (
        <Note title="Without the token the AI client will be refused">
          You set a token, so the client's server must send the same one (<Code>CS2MCP_TOKEN</Code> in its <Code>env</Code>). Turn the switch above on, or add it by hand.
        </Note>
      )}

      <ul className="flex flex-col gap-2" aria-label="Detected AI clients">
        {detected.map((client) => (
          <ClientRow
            key={client.id}
            client={client}
            busy={busy || !server.found}
            onRegister={() =>
              register.mutate({ client: client.id, shareSettings: share && canShare }, { onSuccess: setLast, onError: () => setLast(null) })
            }
            onRemove={() => unregister.mutate({ client: client.id }, { onSuccess: setLast, onError: () => setLast(null) })}
            onCopyCommand={() =>
              snippet.mutate(
                { target: "claude-code", shareSettings: share && canShare, copy: true },
                { onSuccess: () => toast.success("Command copied – run it in PowerShell"), onError: (e) => toast.error(errorText(e)) }
              )
            }
          />
        ))}
        {detected.length === 0 && (
          <li className="text-muted-foreground">No supported AI client found on this PC. Use the snippet below.</li>
        )}
      </ul>

      {register.isError && <Problem title="Could not register">{errorText(register.error)}</Problem>}
      {unregister.isError && <Problem title="Could not remove">{errorText(unregister.error)}</Problem>}
      {last && last.change !== "manual" && (
        <Good title={`${last.name}: ${CHANGE_TEXT[last.change]}`}>
          {last.change !== "unchanged" && last.restart && <>{last.restart} </>}
          {last.backup && (
            <>
              The previous file is kept as <Code>{last.backup}</Code>.
            </>
          )}
          {last.envKeys && last.envKeys.length > 0 && (
            <> Environment passed to the server: {last.envKeys.join(", ")}.</>
          )}
        </Good>
      )}

      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer font-medium">Another client, or do it by hand</summary>
        <div className="mt-3 flex flex-col gap-3">
          {missing.length > 0 && (
            <p className="text-muted-foreground">Not found on this PC: {missing.map((client) => client.name).join(", ")}.</p>
          )}
          <div className="flex flex-wrap gap-1" role="group" aria-label="Snippet format">
            {(
              [
                ["json", "JSON (Claude Desktop, most clients)"],
                ["vscode", "VS Code"],
                ["claude-code", "Claude Code command"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant={target === id ? "secondary" : "outline"}
                aria-pressed={target === id}
                onClick={() => {
                  setTarget(id)
                  snippet.reset()
                }}
              >
                {label}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={!server.found || snippet.isPending}
            onClick={() => snippet.mutate({ target, shareSettings: share && canShare, copy: false })}
          >
            Show the snippet
          </Button>
          {snippet.data && snippet.data.target === target && (
            <>
              <p className="text-muted-foreground">{snippet.data.where}</p>
              <Pre label={snippet.data.title}>{snippet.data.text}</Pre>
              <Button
                size="sm"
                className="self-start"
                onClick={() =>
                  snippet.mutate(
                    { target, shareSettings: share && canShare, copy: true },
                    { onSuccess: () => toast.success("Copied"), onError: (e) => toast.error(errorText(e)) }
                  )
                }
              >
                <CopyIcon data-icon="inline-start" />
                Copy{snippet.data.includesToken ? " (with the token)" : ""}
              </Button>
            </>
          )}
          {snippet.isError && <Problem title="No snippet">{errorText(snippet.error)}</Problem>}
        </div>
      </details>
    </div>
  )
}

const CHANGE_TEXT: Record<Exclude<RegisterResult["change"], "manual">, string> = {
  added: "added",
  updated: "updated",
  removed: "removed",
  unchanged: "already up to date",
}

function ClientRow({
  client,
  busy,
  onRegister,
  onRemove,
  onCopyCommand,
}: {
  client: SetupClient
  busy: boolean
  onRegister: () => void
  onRemove: () => void
  onCopyCommand: () => void
}) {
  const badge = STATE_BADGE[client.state]
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <BotIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className="font-medium">{client.name}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <div className="ms-auto flex flex-wrap gap-2">
          {client.mode === "json" ? (
            <>
              <Button size="sm" onClick={onRegister} disabled={busy || client.state === "unreadable"}>
                {client.state === "none" ? "Register" : client.state === "current" ? "Register again" : "Update"}
              </Button>
              {client.state !== "none" && client.state !== "unreadable" && (
                <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
                  Remove
                </Button>
              )}
            </>
          ) : (
            <Button size="sm" onClick={onCopyCommand} disabled={busy}>
              <CopyIcon data-icon="inline-start" />
              Copy command
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs break-all text-muted-foreground">
        {client.mode === "json" ? (
          <>
            Config file: <Code>{client.configPath}</Code>
            {!client.configExists && " (will be created)"}. A backup is kept next to it before every change.
          </>
        ) : (
          <>
            Claude Code is configured with its own command – run the copied command once in PowerShell. It is registered for every project{client.state !== "none" ? " (an entry named cs2 exists already; the command replaces it after you remove the old one with: claude mcp remove cs2 --scope user)" : ""}.
          </>
        )}
      </p>
      {client.note && <p className="text-xs text-muted-foreground">{client.note}</p>}
      {client.problem && <p className="text-xs text-destructive">{client.problem}</p>}
      {client.state === "outdated" && client.entry && (
        <p className="text-xs text-muted-foreground">
          Currently starts <Code>{[client.entry.command ?? "?", ...client.entry.args].join(" ")}</Code>, not this app's server.
        </p>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------------------------

const EXAMPLE_PROMPTS = [
  "How is my city doing? Summarise the finances, traffic and any warnings.",
  "Take a screenshot of my city and tell me what you think needs attention first.",
  "Which neighbourhoods have the worst happiness, and why?",
]

export function DoneStep({ status }: { status: SetupStatus }) {
  const registered = status.clients.filter((client) => client.state === "current" || client.state === "outdated")
  return (
    <div className="flex flex-col gap-4 text-sm">
      <ul className="flex flex-col gap-1.5">
        <SummaryItem ok={status.bridge.link === "ready" || status.bridge.link === "no-city" || status.bridge.link === "loading"}>
          Game mod: {status.bridge.link === "unreachable" ? "not reachable yet – start the game" : status.bridge.link === "disabled" ? "switched off in the game's options" : status.bridge.link === "unauthorized" ? "token mismatch" : `connected (${status.bridge.modVersion})`}
        </SummaryItem>
        <SummaryItem ok={true}>Token: {status.token.set ? "set" : "none (optional)"}</SummaryItem>
        <SummaryItem ok={registered.length > 0}>
          AI client: {registered.length > 0 ? registered.map((client) => client.name).join(", ") : "none registered yet (go back to add one, or use the snippet)"}
        </SummaryItem>
      </ul>
      {registered.length > 0 && (
        <p>
          <strong>Restart your AI client completely</strong> so it starts the server (Claude Desktop: quit it from the tray icon, not just the window). Load a save in the game, then try:
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Example prompts">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt} className="flex items-center gap-2 rounded-lg border p-2.5">
            <span className="flex-1">{prompt}</span>
            <Button variant="ghost" size="icon-sm" aria-label={`Copy prompt: ${prompt}`} onClick={() => void copyPlain(prompt, "Prompt")}>
              <CopyIcon />
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        Everything the AI changes shows up under <strong>AI activity</strong> with its cost. In the game, <strong>Options → CS2MCP</strong> has a read-only mode and a spending limit.
      </p>
    </div>
  )
}

function SummaryItem({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {ok ? (
        <CircleCheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" aria-label="done" />
      ) : (
        <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" aria-label="to do" />
      )}
      <span>{children}</span>
    </li>
  )
}
