import type { LucideIcon } from "lucide-react"
import { Component, type ErrorInfo, type ReactNode } from "react"

import { QueryError } from "@/components/query-error"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** One card of the settings page; `id` is the anchor (/settings#<id>) and labels the region. */
export function SettingsSection({
  id,
  title,
  description,
  icon: Icon,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  icon?: LucideIcon
  children: ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-4">
      <Card>
        <CardHeader>
          <CardTitle id={`${id}-title`} className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
            <h2>{title}</h2>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>
          <SectionBoundary title={title}>{children}</SectionBoundary>
        </CardContent>
      </Card>
    </section>
  )
}

/** A section that throws shows its error instead of taking the whole page down. */
class SectionBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`settings section "${this.props.title}" failed`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return <QueryError title={`The ${this.props.title} settings could not be shown`} error={this.state.error} />
    }
    return this.props.children
  }
}
