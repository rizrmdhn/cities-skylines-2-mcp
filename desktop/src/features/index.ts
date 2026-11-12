/**
 * Feature registration list: ONE line per feature, kept in alphabetical order.
 *
 *   export { default as <camelCaseId> } from "./<id>.ts"
 *
 * main.ts sets up every export of this module (in alphabetical order of the export name).
 * Features must not depend on that order: use ctx.onReady for work that needs other features.
 */
export { default as appFolders } from "./app-folders.ts"
export { default as historyArchive } from "./history-archive.ts"
export { default as settingsApi } from "./settings-api.ts"
