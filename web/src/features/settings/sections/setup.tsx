import { Link } from "@tanstack/react-router"
import { WandSparklesIcon } from "lucide-react"

import { buttonVariants } from "@/components/ui/button"
import { defineSettingsSection } from "@/features/settings/define-section"

function SetupSettings() {
  return (
    <div className="flex flex-col items-start gap-3 text-sm">
      <p className="text-muted-foreground">
        Check the game mod, create a token and add this app's built-in MCP server to Claude Desktop, Claude Code, Cursor or VS Code. Nothing is changed until you press a button in the wizard.
      </p>
      <Link to="/setup" className={buttonVariants({ variant: "outline" })}>
        <WandSparklesIcon data-icon="inline-start" />
        Run setup again
      </Link>
    </div>
  )
}

export default defineSettingsSection({
  id: "setup",
  title: "Setup",
  description: "The first-run wizard for the game mod, the token and your AI client.",
  icon: WandSparklesIcon,
  component: SetupSettings,
})
