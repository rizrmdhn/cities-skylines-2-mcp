import { CopyIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { GridLayer, GridMap } from "@/lib/bridge-types"
import { formatLayerValue, LAYER_LABELS } from "@/features/map/layers"
import { valueAt } from "@/lib/heatmap"
import {
  describeSelection,
  promptTemplates,
  selectionSize,
  type Selection,
} from "@/lib/selection"

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success("Copied to the clipboard", { description: text })
  } catch {
    toast.error("Could not copy: the browser blocked clipboard access")
  }
}

const KIND_LABEL: Record<Selection["kind"], string> = {
  point: "Point",
  box: "Area",
  line: "Line",
}

export function SelectionPanel({
  selection,
  layer,
  grid,
  onClear,
}: {
  selection: Selection | undefined
  layer: GridLayer
  grid: GridMap | undefined
  onClear: () => void
}) {
  if (!selection) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>Pick a location</CardTitle>
          <CardDescription>
            Click the map to pick a point. Switch to Area or Line in the toolbar and drag to mark an
            area or a route. The coordinates come with ready-to-paste prompts for the AI.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const pointValue =
    selection.kind === "point" && grid ? valueAt(grid, selection.at) : undefined
  const context =
    pointValue !== undefined
      ? `${LAYER_LABELS[layer].toLowerCase()} ${formatLayerValue(pointValue)}`
      : undefined
  const size = selectionSize(selection)

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <Badge variant="outline">{KIND_LABEL[selection.kind]}</Badge>
        </CardTitle>
        <CardDescription className="font-mono tabular-nums" data-testid="selection-coordinates">
          {describeSelection(selection)}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}>
            <XIcon />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(size || context) && (
          <p className="text-sm text-muted-foreground">
            {[size, context && `${context[0].toUpperCase()}${context.slice(1)}`]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        <Separator />
        <ul className="flex flex-col gap-3" aria-label="Prompts">
          {promptTemplates(selection, context).map((template) => (
            <li key={template.id} className="flex items-start gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">{template.label}</span>
                <span className="text-sm break-words">{template.text}</span>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label={`Copy: ${template.label}`}
                      onClick={() => copy(template.text)}
                    />
                  }
                >
                  <CopyIcon />
                </TooltipTrigger>
                <TooltipContent>Copy</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
