/** How long the object URL stays valid after the click, so the browser can start the save. */
export const REVOKE_DELAY_MS = 1000;

/**
 * Save text as a CSV file on this device via a temporary link. The object URL is
 * released only after a delay: revoking it right after the click can cancel the
 * download in some browsers. Throws if the click fails; the caller says so.
 * Nothing leaves the browser.
 */
export function downloadCsvFile(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}
