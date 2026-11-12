/**
 * Settings section registration list: ONE line per desktop feature that has settings, kept in
 * alphabetical order. The export name is the camelCase feature id, the file is sections/<id>.tsx:
 *
 *   export { default as <camelCaseId> } from "./<id>"
 *
 * The settings page renders them in this order, each only when the desktop app reports the
 * feature as started. See "Adding a settings section" in desktop/README.md.
 */
export {}
