import { CircleAlertIcon, PlugIcon, RotateCcwIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react"
import { useId, useState, type FormEvent } from "react"

import { QueryError } from "@/components/query-error"
import { STATUS_ICON, STATUS_LABEL } from "@/components/connection-status"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useConnectionTest, type ConnectionTestResult } from "@/features/settings/connection-test"
import { bridgeUrlProblem, DEFAULT_BRIDGE_URL, SOURCE_LABEL } from "@/features/settings/connection-config"
import { SaveIndicator } from "@/features/settings/fields"
import { SettingsSection } from "@/features/settings/section-card"
import { useDesktopSettings, useSaveSettings } from "@/features/settings/use-settings"
import { APP_VERSION } from "@/lib/connection"
import type { DesktopSettings } from "@/lib/desktop"

export function ConnectionSection() {
  const settings = useDesktopSettings()
  return (
    <SettingsSection
      id="connection"
      title="Connection"
      icon={PlugIcon}
      description="Which CS2MCP bridge this app talks to. Changes apply at once, without a restart."
    >
      {settings.isError ? (
        <QueryError title="Could not load the settings" error={settings.error} />
      ) : !settings.data ? (
        <Skeleton className="h-48" />
      ) : (
        <ConnectionForm settings={settings.data} />
      )}
    </SettingsSection>
  )
}

function ConnectionForm({ settings }: { settings: DesktopSettings }) {
  const urlId = useId()
  const tokenId = useId()
  const saver = useSaveSettings()
  const test = useConnectionTest()
  /** null = untouched: show what is saved. */
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [urlProblem, setUrlProblem] = useState<string>()

  const savedUrl = settings.bridgeUrl ?? ""
  const urlText = urlDraft ?? savedUrl
  const urlDirty = urlDraft !== null && urlDraft.trim() !== savedUrl
  const tokenDirty = token.trim() !== ""
  const dirty = urlDirty || tokenDirty
  const { effective } = settings

  const urlError = urlProblem ?? saver.issues.find((issue) => issue.key === "bridgeUrl")?.message
  const tokenError = saver.issues.find((issue) => issue.key === "token")?.message
  const formError = saver.issues.find((issue) => issue.key === null)?.message

  async function save(patch: Record<string, unknown>) {
    if (await saver.save(patch)) {
      if ("bridgeUrl" in patch) setUrlDraft(null)
      if ("token" in patch) setToken("")
      test.mutate()
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!dirty) return
    const patch: Record<string, unknown> = {}
    if (urlDirty) {
      const value = urlText.trim()
      const problem = bridgeUrlProblem(value)
      if (problem) {
        setUrlProblem(problem)
        return
      }
      patch.bridgeUrl = value === "" ? null : value
    }
    if (tokenDirty) patch.token = token
    void save(patch)
  }

  function discard() {
    setUrlDraft(null)
    setToken("")
    setUrlProblem(undefined)
    saver.clearError()
  }

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-6">
      <FieldGroup>
        <Field data-invalid={urlError ? true : undefined}>
          <FieldLabel htmlFor={urlId}>Bridge URL</FieldLabel>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              placeholder={DEFAULT_BRIDGE_URL}
              value={urlText}
              aria-invalid={urlError ? true : undefined}
              aria-describedby={`${urlId}-effective${urlError ? ` ${urlId}-error` : ""}`}
              onChange={(event) => {
                setUrlDraft(event.target.value)
                setUrlProblem(undefined)
                saver.clearError()
              }}
            />
            {settings.bridgeUrl !== null && (
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={saver.saving}
                onClick={() => void save({ bridgeUrl: null })}
              >
                <RotateCcwIcon data-icon="inline-start" />
                Reset to default
              </Button>
            )}
          </div>
          <FieldError id={`${urlId}-error`}>{urlError}</FieldError>
          <FieldDescription id={`${urlId}-effective`}>
            In effect: <code className="font-mono text-foreground">{effective.bridgeUrl}</code>{" "}
            <Badge variant="outline">{SOURCE_LABEL[effective.bridgeUrlSource]}</Badge>
            {settings.bridgeUrl === null && effective.bridgeUrlSource !== "env" && (
              <> · Leave empty to use {effective.bridgeUrlSource === "dotenv" ? "the .env file" : "the default"}.</>
            )}
          </FieldDescription>
          {effective.bridgeUrlSource === "env" && (
            <EnvWins variable="CS2_BRIDGE_URL" what="URL" saved={settings.bridgeUrl !== null} />
          )}
        </Field>

        <Field data-invalid={tokenError ? true : undefined}>
          <div className="flex flex-wrap items-center gap-2">
            <FieldLabel htmlFor={tokenId}>Token</FieldLabel>
            <Badge variant={effective.tokenSet ? "secondary" : "outline"} id={`${tokenId}-status`}>
              {effective.tokenSet ? `Set (${SOURCE_LABEL[effective.tokenSource]})` : "Not set"}
            </Badge>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={tokenId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              placeholder={settings.tokenSet ? "Type a new token to replace the saved one" : "Paste the token the game uses"}
              value={token}
              aria-invalid={tokenError ? true : undefined}
              aria-describedby={`${tokenId}-status ${tokenId}-help${tokenError ? ` ${tokenId}-error` : ""}`}
              onChange={(event) => {
                setToken(event.target.value)
                saver.clearError()
              }}
            />
            {settings.tokenSet && (
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={saver.saving}
                onClick={() => {
                  setToken("")
                  void save({ token: null })
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Clear token
              </Button>
            )}
          </div>
          <FieldError id={`${tokenId}-error`}>{tokenError}</FieldError>
          <FieldDescription id={`${tokenId}-help`}>
            Must match the token set for the game (CS2MCP_TOKEN). It is write-only: once saved it
            is never shown again.
            {settings.tokenSet && " A token is saved here; type a new one to replace it."}
          </FieldDescription>
          {effective.tokenSource === "env" && (
            <EnvWins variable="CS2MCP_TOKEN" what="token" saved={settings.tokenSet} />
          )}
          {!settings.secretsEncrypted && (
            <Alert>
              <ShieldAlertIcon />
              <AlertTitle>The token is stored as plain text</AlertTitle>
              <AlertDescription>
                No OS keystore is available, so a token saved here is written unencrypted to
                settings.json in the settings folder.
              </AlertDescription>
            </Alert>
          )}
        </Field>
      </FieldGroup>

      {formError && <FieldError>{formError}</FieldError>}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!dirty || saver.saving}>
          {saver.saving && <Spinner data-icon="inline-start" />}
          Save
        </Button>
        {dirty && (
          <Button type="button" variant="ghost" onClick={discard}>
            Discard
          </Button>
        )}
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {dirty ? "Unsaved changes. The test uses what is saved." : null}
        </span>
        {!dirty && <SaveIndicator status={saver.saving ? "saving" : saver.saved ? "saved" : "idle"} />}
        <Button
          type="button"
          variant="outline"
          className="ms-auto"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? <Spinner data-icon="inline-start" /> : <PlugIcon data-icon="inline-start" />}
          Test connection
        </Button>
      </div>

      <div aria-live="polite" className="empty:hidden">
        {test.isError && <QueryError title="Could not run the test" error={test.error} />}
        {test.data && !test.isPending && <TestResult result={test.data} />}
      </div>
    </form>
  )
}

function EnvWins({ variable, what, saved }: { variable: string; what: string; saved: boolean }) {
  return (
    <Alert>
      <CircleAlertIcon />
      <AlertTitle>{variable} is set in the environment</AlertTitle>
      <AlertDescription>
        The environment variable takes precedence over this page.{" "}
        {saved ? `The ${what} saved here is kept but not in effect` : `A ${what} saved here will not take effect`}{" "}
        until the variable is removed and the app restarted.
      </AlertDescription>
    </Alert>
  )
}

function resultText(result: ConnectionTestResult): string {
  const mod = `CS2MCP ${result.modVersion ?? "(unknown version)"}`
  switch (result.status) {
    case "ready":
      return `Reached ${mod} at ${result.bridgeUrl}; the city ${result.cityName ?? ""} is loaded.`
    case "no-city":
      return `Reached ${mod} at ${result.bridgeUrl}. No city is loaded: load a save to see city data.`
    case "loading":
      return `Reached ${mod} at ${result.bridgeUrl}. The game is still loading.`
    case "disabled":
      return `Reached ${mod} at ${result.bridgeUrl}, but the bridge is switched off. Turn on Accept AI requests in the game's Options > CS2MCP page.`
    case "unauthorized":
      return `The bridge at ${result.bridgeUrl} rejected the token. Set the token the game uses (Options > CS2MCP), or clear it if the game has none.`
    case "unreachable":
      return result.reached
        ? `Reached ${mod} at ${result.bridgeUrl}, but the city state could not be read.`
        : `Nothing answered at ${result.bridgeUrl}. Start Cities: Skylines II with the CS2MCP mod enabled, or check the URL.`
  }
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  const Icon = STATUS_ICON[result.status]
  const failed = result.status === "unreachable" || result.status === "unauthorized"
  return (
    <Alert variant={failed ? "destructive" : "default"} data-testid="connection-test-result">
      <Icon />
      <AlertTitle>{STATUS_LABEL[result.status]}</AlertTitle>
      <AlertDescription>
        <p>{resultText(result)}</p>
        {result.error && <p className="font-mono text-xs break-all">{result.error}</p>}
        {result.versionMismatch && (
          <p>
            Version mismatch: the game runs CS2MCP {result.modVersion} but this app is {APP_VERSION}.
            Update whichever is behind.
          </p>
        )}
        {result.readOnly && <p>The bridge is read-only: the AI can look but not change the city.</p>}
      </AlertDescription>
    </Alert>
  )
}
