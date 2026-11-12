/**
 * Building blocks for settings sections, so every section looks and behaves the same. Each row
 * takes a SettingField from useSetting() and shows its label, description, save state and the
 * per-field error from the desktop app. Switches and selects save on change; number, text and
 * hotkey rows save when the field is left or Enter is pressed (Escape restores the saved value).
 */
import { CheckIcon, KeyboardIcon, XIcon } from "lucide-react"
import { useId, useState, type KeyboardEvent, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { captureHotkey, hotkeyParts } from "@/features/settings/hotkey"
import type { SaveStatus, SettingField } from "@/features/settings/use-settings"
import { cn } from "@/lib/utils"

/** "Saving…" / "Saved" next to a label; announced politely to screen readers. */
export function SaveIndicator({ status, className }: { status: SaveStatus; className?: string }) {
  return (
    <span
      aria-live="polite"
      className={cn("inline-flex items-center gap-1 text-xs font-normal text-muted-foreground", className)}
    >
      {status === "saving" && (
        <>
          <Spinner className="size-3" />
          Saving…
        </>
      )}
      {status === "saved" && (
        <>
          <CheckIcon className="size-3" />
          Saved
        </>
      )}
    </span>
  )
}

interface RowProps<T> {
  setting: SettingField<T>
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

/** Label, description, save state and error of a row; the control goes next to it. */
function RowText({
  id,
  label,
  description,
  status,
  error,
}: {
  id: string
  label: ReactNode
  description?: ReactNode
  status: SaveStatus
  error: string | undefined
}) {
  return (
    <FieldContent>
      <div className="flex flex-wrap items-center gap-x-2">
        <FieldLabel id={`${id}-label`} htmlFor={id}>
          {label}
        </FieldLabel>
        <SaveIndicator status={status} />
      </div>
      {description && <FieldDescription id={`${id}-description`}>{description}</FieldDescription>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </FieldContent>
  )
}

function describedBy(id: string, description: ReactNode, error: string | undefined) {
  return [description ? `${id}-description` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined
}

/** An on/off setting; saves when toggled. */
export function SwitchRow({ setting, label, description, disabled }: RowProps<boolean>) {
  const id = useId()
  return (
    <Field orientation="horizontal" data-invalid={setting.error ? true : undefined}>
      <RowText id={id} label={label} description={description} status={setting.status} error={setting.error} />
      <Switch
        id={id}
        checked={setting.value}
        disabled={disabled || !setting.available}
        aria-invalid={setting.error ? true : undefined}
        aria-describedby={describedBy(id, description, setting.error)}
        onCheckedChange={(checked) => void setting.save(checked)}
      />
    </Field>
  )
}

export interface SelectOption<T extends string> {
  value: T
  label: string
}

/** One of a few values; saves when picked. */
export function SelectRow<T extends string>({
  setting,
  label,
  description,
  disabled,
  options,
}: RowProps<T> & { options: readonly SelectOption<T>[] }) {
  const id = useId()
  return (
    <Field orientation="responsive" data-invalid={setting.error ? true : undefined}>
      <RowText id={id} label={label} description={description} status={setting.status} error={setting.error} />
      <Select
        items={options}
        value={setting.value}
        disabled={disabled || !setting.available}
        onValueChange={(value) => {
          if (value !== null) void setting.save(value as T)
        }}
      >
        <SelectTrigger
          id={id}
          className="@md/field-group:w-48"
          aria-invalid={setting.error ? true : undefined}
          aria-describedby={describedBy(id, description, setting.error)}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

/**
 * Draft state of a typed-in value: shows the saved value until edited, saves on commit, keeps the
 * draft while the save is refused, and goes back to the saved value on Escape.
 */
function useDraft<T>(setting: SettingField<T>, toText: (value: T) => string) {
  const [draft, setDraft] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string>()
  return {
    text: draft ?? toText(setting.value),
    error: localError ?? setting.error,
    edit(text: string) {
      setDraft(text)
      setLocalError(undefined)
      setting.clearError()
    },
    revert() {
      setDraft(null)
      setLocalError(undefined)
      setting.clearError()
    },
    /** `parse` returns the value to save or an error message. */
    async commit(parse: (text: string) => { value: T } | { error: string }) {
      if (draft === null) return
      const parsed = parse(draft)
      if ("error" in parsed) {
        setLocalError(parsed.error)
        return
      }
      if (toText(parsed.value) === toText(setting.value) && !setting.error) {
        setDraft(null)
        return
      }
      if (await setting.save(parsed.value)) setDraft(null)
    },
  }
}

function commitKeys(onCommit: () => void, onRevert: () => void) {
  return (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      onCommit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onRevert()
    }
  }
}

/** A number; saved when the field is left or Enter is pressed. */
export function NumberRow({
  setting,
  label,
  description,
  disabled,
  min,
  max,
  step = 1,
  unit,
}: RowProps<number> & { min?: number; max?: number; step?: number; unit?: string }) {
  const id = useId()
  const draft = useDraft(setting, String)
  const integer = Number.isInteger(step)
  const parse = (text: string): { value: number } | { error: string } => {
    const value = Number(text.trim())
    const range =
      min !== undefined && max !== undefined
        ? ` from ${min} to ${max}`
        : min !== undefined
          ? ` of at least ${min}`
          : max !== undefined
            ? ` of at most ${max}`
            : ""
    const message = `Enter a ${integer ? "whole number" : "number"}${range}.`
    if (text.trim() === "" || !Number.isFinite(value)) return { error: message }
    if ((integer && !Number.isInteger(value)) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
      return { error: message }
    }
    return { value }
  }
  const commit = () => void draft.commit(parse)
  return (
    <Field orientation="responsive" data-invalid={draft.error ? true : undefined}>
      <RowText id={id} label={label} description={description} status={setting.status} error={draft.error} />
      <div className="flex items-center gap-2 @md/field-group:w-48">
        <Input
          id={id}
          type="number"
          inputMode={integer ? "numeric" : "decimal"}
          min={min}
          max={max}
          step={step}
          value={draft.text}
          disabled={disabled || !setting.available}
          aria-invalid={draft.error ? true : undefined}
          aria-describedby={describedBy(id, description, draft.error)}
          onChange={(event) => draft.edit(event.target.value)}
          onBlur={commit}
          onKeyDown={commitKeys(commit, draft.revert)}
        />
        {unit && <span className="shrink-0 text-sm text-muted-foreground">{unit}</span>}
      </div>
    </Field>
  )
}

/** A line of text; an empty field saves null (back to the feature's default). */
export function TextRow({
  setting,
  label,
  description,
  disabled,
  placeholder,
  validate,
}: RowProps<string | null> & {
  placeholder?: string
  /** Client-side check before saving; return a message to refuse. The desktop app validates again. */
  validate?: (value: string) => string | undefined
}) {
  const id = useId()
  const draft = useDraft(setting, (value) => value ?? "")
  const commit = () =>
    void draft.commit((text) => {
      const value = text.trim()
      if (value === "") return { value: null }
      const error = validate?.(value)
      return error ? { error } : { value }
    })
  return (
    <Field orientation="responsive" data-invalid={draft.error ? true : undefined}>
      <RowText id={id} label={label} description={description} status={setting.status} error={draft.error} />
      <Input
        id={id}
        className="@md/field-group:w-64"
        value={draft.text}
        placeholder={placeholder}
        disabled={disabled || !setting.available}
        aria-invalid={draft.error ? true : undefined}
        aria-describedby={describedBy(id, description, draft.error)}
        onChange={(event) => draft.edit(event.target.value)}
        onBlur={commit}
        onKeyDown={commitKeys(commit, draft.revert)}
      />
    </Field>
  )
}

/** Shows an accelerator ("CommandOrControl+Shift+O") as keys. */
export function Hotkey({ accelerator }: { accelerator: string }) {
  return (
    <KbdGroup>
      {hotkeyParts(accelerator).map((part, index) => (
        <Kbd key={index}>{part}</Kbd>
      ))}
    </KbdGroup>
  )
}

/**
 * A keyboard shortcut in Electron accelerator format (pass it to globalShortcut.register as is).
 * "Record" listens for the next key combination; Escape cancels, Tab moves on, "Clear" saves null.
 */
export function HotkeyRow({ setting, label, description, disabled }: RowProps<string | null>) {
  const id = useId()
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState<string>()
  const error = hint ?? setting.error
  const unavailable = disabled || !setting.available

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording) return
    const bare = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey
    if (bare && event.key === "Tab") {
      setRecording(false)
      setHint(undefined)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (bare && event.key === "Escape") {
      setRecording(false)
      setHint(undefined)
      return
    }
    const result = captureHotkey(event)
    if (result.kind === "modifier-only") return
    if (result.kind === "needs-modifier") {
      setHint("Hold Ctrl or Alt with the key, or use a function key (F1–F24).")
      return
    }
    if (result.kind === "unsupported") {
      setHint("That key cannot be used for a shortcut.")
      return
    }
    setRecording(false)
    setHint(undefined)
    void setting.save(result.accelerator)
  }

  return (
    <Field orientation="responsive" data-invalid={error ? true : undefined}>
      <RowText id={id} label={label} description={description} status={setting.status} error={error} />
      <div className="flex items-center gap-2">
        <Button
          id={id}
          type="button"
          variant="outline"
          className="min-w-36 justify-start"
          aria-pressed={recording}
          aria-labelledby={`${id}-label ${id}-value`}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, description, error)}
          disabled={unavailable}
          onClick={() => {
            setRecording((on) => !on)
            setHint(undefined)
            setting.clearError()
          }}
          onBlur={() => setRecording(false)}
          onKeyDown={onKeyDown}
        >
          <KeyboardIcon data-icon="inline-start" />
          <span id={`${id}-value`} className="contents">
            {recording ? (
              "Press a shortcut…"
            ) : setting.value ? (
              <Hotkey accelerator={setting.value} />
            ) : (
              "Record shortcut"
            )}
          </span>
        </Button>
        {setting.value && !recording && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Clear shortcut"
            disabled={unavailable}
            onClick={() => void setting.save(null)}
          >
            <XIcon />
          </Button>
        )}
      </div>
    </Field>
  )
}
