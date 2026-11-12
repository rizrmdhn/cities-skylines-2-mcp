import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { inspect } from "node:util"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(message: string, ...details: unknown[]): void
  info(message: string, ...details: unknown[]): void
  warn(message: string, ...details: unknown[]): void
  error(message: string, ...details: unknown[]): void
  /** Same log, every line prefixed with [scope] (features get one named after their id). */
  child(scope: string): Logger
}

/** Where log lines go: one already formatted line at a time. */
export type LogSink = (level: LogLevel, line: string) => void

function format(level: LogLevel, scope: string | undefined, message: string, details: unknown[]) {
  const parts = details.map((detail) =>
    detail instanceof Error
      ? (detail.stack ?? `${detail.name}: ${detail.message}`)
      : typeof detail === "string"
        ? detail
        : inspect(detail, { depth: 4, breakLength: Infinity })
  )
  const prefix = scope ? `[${scope}] ` : ""
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${prefix}${[message, ...parts].join(" ")}`
}

export function createLogger(sink: LogSink, scope?: string): Logger {
  const write = (level: LogLevel) => (message: string, ...details: unknown[]) =>
    sink(level, format(level, scope, message, details))
  return {
    debug: write("debug"),
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    child: (child) => createLogger(sink, scope ? `${scope}:${child}` : child),
  }
}

export interface FileLogOptions {
  /** e.g. <userData>/logs/main.log */
  file: string
  /** Rotated to <file>.1 when it grows past this. Default 1 MiB. */
  maxBytes?: number
  /** Also print to the console (dev). */
  echo?: boolean
}

/**
 * Appends synchronously so the last lines survive a crash; the volume is small. A log past
 * maxBytes is moved to `<file>.1` (one generation kept).
 */
export function createFileSink({ file, maxBytes = 1024 * 1024, echo = false }: FileLogOptions): LogSink {
  mkdirSync(dirname(file), { recursive: true })
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    size = 0
  }
  return (level, line) => {
    if (echo) (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line)
    try {
      if (size > maxBytes) {
        rmSync(`${file}.1`, { force: true })
        renameSync(file, `${file}.1`)
        size = 0
      }
      const text = line + "\n"
      appendFileSync(file, text, "utf8")
      size += Buffer.byteLength(text)
    } catch {
      // logging must never take the app down
    }
  }
}

/** Keeps lines in memory (tests). */
export function createMemorySink(lines: string[] = []): LogSink & { lines: string[] } {
  const sink = ((_level: LogLevel, line: string) => {
    lines.push(line)
  }) as LogSink & { lines: string[] }
  sink.lines = lines
  return sink
}
