import { actionLabel, formatMoneyDelta } from "@/lib/format"
import { stepEntries, type Step } from "@/lib/sessions"

/** "road connect", or "batch (3 parts)" for a batch, with a note when its own result was not logged. */
export function stepTitle(step: Step) {
  if (step.kind === "single") return actionLabel(step.path)
  const parts = `${step.parts.length} part${step.parts.length === 1 ? "" : "s"}`
  return `${actionLabel(step.path)} (${parts}${step.entry ? "" : ", batch result not logged"})`
}

/** "done", "failed 400", "failed (1 of 3 parts)". */
export function stepResultLabel(step: Step) {
  if (step.ok) return "done"
  if (step.kind === "batch" && step.failedParts > 0) {
    return `failed (${step.failedParts} of ${step.parts.length} parts)`
  }
  return `failed${step.entry?.status ? ` ${step.entry.status}` : ""}`
}

/** "road connect × 2, taxes set": what a batch ran, or the asset a single step used. */
export function stepDetail(step: Step) {
  if (step.kind === "single") {
    const query = step.entry?.query ?? {}
    return query.prefab ?? query.zone ?? ""
  }
  const counts = new Map<string, number>()
  for (const part of step.parts) {
    const label = actionLabel(part.path)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${label} × ${n}` : label)).join(", ")
}

/** One line for a step: "road connect (3 parts) — failed (1 of 3 parts) — -¢30,000". */
export function stepSummary(step: Step) {
  const detail = stepDetail(step)
  const title = stepTitle(step)
  return `${title}${step.kind === "single" && detail ? ` · ${detail}` : ""} — ${stepResultLabel(step)} — ${formatMoneyDelta(step.moneyDelta)}`
}

/** The log entry id the entry sheet should open for a step. */
export function stepEntryId(step: Step) {
  return (step.entry ?? stepEntries(step)[0]).id
}
