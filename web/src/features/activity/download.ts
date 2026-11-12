/**
 * Saves text as a file: a Blob URL clicked through a temporary <a download>. Works in the
 * browser companion and in the desktop window (the click does not navigate, so the app's
 * navigation guard is not involved; Electron shows its Save dialog). Kept local to the activity
 * feature on purpose; see the desktop notes in the activity page's export menu.
 */
export function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = document.createElement("a")
  link.href = url
  link.download = fileName
  link.rel = "noopener"
  link.style.display = "none"
  document.body.append(link)
  try {
    link.click()
  } finally {
    link.remove()
    // The download has taken its copy once the click returned; give slow handlers a moment anyway.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
}
