/** Own the native promise even when Android has already destroyed its activity. */
export async function applySystemBackground(
  apply: () => Promise<void>,
  report: (error: unknown) => void,
): Promise<void> {
  try {
    await apply();
  } catch (error) {
    if (error instanceof Error && error.message ===
      "Call to function 'ExpoSystemUI.setBackgroundColorAsync' has been rejected.\n→ Caused by: The current activity is no longer available") return;
    report(error);
  }
}
