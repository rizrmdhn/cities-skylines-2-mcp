/**
 * Keyboard shortcuts in Electron's accelerator format ("CommandOrControl+Shift+O"), the format
 * globalShortcut.register takes, so a hotkey setting can be passed to it unchanged.
 */

const NAMED_KEYS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  PrintScreen: "PrintScreen",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
}

/** The accelerator key for a physical key (event.code), independent of the keyboard layout. */
function keyName(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS[code]
}

const isFunctionKey = (key: string) => /^F\d+$/.test(key)

export type HotkeyCapture =
  | { kind: "modifier-only" }
  | { kind: "needs-modifier"; key: string }
  | { kind: "unsupported" }
  | { kind: "accelerator"; accelerator: string }

/**
 * Turns a keydown into an accelerator. A global hotkey needs Ctrl, Alt or Shift with a key
 * (function keys may stand alone), otherwise it would swallow normal typing in the game.
 */
export function captureHotkey(event: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): HotkeyCapture {
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(event.code)) return { kind: "modifier-only" }
  const key = keyName(event.code)
  if (!key) return { kind: "unsupported" }
  const modifiers = [
    event.ctrlKey && "CommandOrControl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Super",
  ].filter((modifier): modifier is string => Boolean(modifier))
  const hasNonShift = event.ctrlKey || event.altKey || event.metaKey
  if (!hasNonShift && !isFunctionKey(key)) return { kind: "needs-modifier", key }
  return { kind: "accelerator", accelerator: [...modifiers, key].join("+") }
}

const DISPLAY: Record<string, string> = {
  CommandOrControl: "Ctrl",
  CmdOrCtrl: "Ctrl",
  Control: "Ctrl",
  Super: "Win",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
}

/** "CommandOrControl+Shift+O" -> ["Ctrl", "Shift", "O"] for display. */
export function hotkeyParts(accelerator: string): string[] {
  return accelerator
    .split("+")
    .filter(Boolean)
    .map((part) => DISPLAY[part] ?? part)
}
