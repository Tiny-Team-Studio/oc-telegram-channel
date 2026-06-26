export async function postShim(
  path: "/reply" | "/react" | "/edit_message",
  body: Record<string, unknown>,
  success: string,
): Promise<string> {
  const port = process.env.SHIM_PORT || "4097";
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => ({ ok: false })) as { ok?: boolean; error?: string };
    return json.ok ? success : `${success} failed: ${json.error ?? res.status}`;
  } catch (e: any) {
    if (e?.name === "TimeoutError") {
      return `${success} timed out (no response from the Telegram channel within 30s)`;
    }
    return `${success} failed: ${e?.message ?? String(e)}`;
  }
}
