/**
 * Formats an error for logs from its name, message, HTTP status and stack only. Never log the error object
 * itself: gaxios errors carry the request config as an enumerable property, and for Google token exchanges
 * that config includes client_secret.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return typeof e === "string" ? e : Object.prototype.toString.call(e);
  const status = (e as { response?: { status?: unknown } }).response?.status;
  const code = (e as { code?: unknown }).code;
  const extra = [
    typeof status === "number" ? `status=${status}` : "",
    typeof code === "string" || typeof code === "number" ? `code=${code}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const frames = e.stack?.split("\n").slice(1).join("\n");
  return `${e.name}: ${e.message}${extra ? ` (${extra})` : ""}${frames ? `\n${frames}` : ""}`;
}
