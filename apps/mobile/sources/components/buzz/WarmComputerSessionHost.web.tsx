// The web opens live browsers in a dialog, so the root host draws nothing.
// This entry keeps the viewer code out of the web startup path.
export function WarmComputerSessionHost(): null {
  return null;
}
