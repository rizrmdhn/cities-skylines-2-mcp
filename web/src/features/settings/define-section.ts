/**
 * What a feature's settings section is. Kept apart from registry.ts (which imports every section)
 * so a section file can import defineSettingsSection without an import cycle.
 */
import type { LucideIcon } from "lucide-react"
import type { ComponentType } from "react"

export interface SettingsSectionDefinition {
  /** The desktop feature id (kebab-case); the section renders only when info.features has it. Also the page anchor: /settings#<id>. */
  id: string
  /** Card title, e.g. "System tray". */
  title: string
  /** One line under the title. */
  description?: string
  icon?: LucideIcon
  /** The rows: SwitchRow, SelectRow, NumberRow, TextRow, HotkeyRow (fields.tsx), laid out in a FieldGroup. */
  component: ComponentType
}

const SECTION_ID = /^[a-z][a-z0-9-]*$/

/** Identity helper that types a section: export default defineSettingsSection({ ... }) */
export function defineSettingsSection(section: SettingsSectionDefinition): SettingsSectionDefinition {
  if (!SECTION_ID.test(section.id)) {
    throw new Error(`settings section id "${section.id}" must be the feature's kebab-case id`)
  }
  return section
}
