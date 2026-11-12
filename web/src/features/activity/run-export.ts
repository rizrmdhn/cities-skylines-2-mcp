import { downloadText } from "@/features/activity/download"
import {
  exportFileName,
  historyJsonExport,
  historyMarkdown,
  sessionJsonExport,
  sessionMarkdown,
  type ExportContext,
} from "@/features/activity/session-export"
import type { Session } from "@/lib/sessions"

export type ExportFormat = "md" | "json"

const TYPES: Record<ExportFormat, string> = { md: "text/markdown", json: "application/json" }

/** Saves one session as a report; returns the file name. */
export function exportSession(session: Session, format: ExportFormat, context: ExportContext = {}) {
  const name = exportFileName({ session }, format, context)
  const text = format === "md" ? sessionMarkdown(session, context) : sessionJsonExport(session, context)
  downloadText(name, text, TYPES[format])
  return name
}

/** Saves every given session (what the page currently shows) as one report; returns the file name. */
export function exportHistory(sessions: readonly Session[], format: ExportFormat, context: ExportContext = {}) {
  const name = exportFileName({ sessions }, format, context)
  const text = format === "md" ? historyMarkdown(sessions, context) : historyJsonExport(sessions, context)
  downloadText(name, text, TYPES[format])
  return name
}
