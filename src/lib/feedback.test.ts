import { expect, it, vi } from "vitest";
import { FEEDBACK_URL, MAX_BODY_BYTES, buildFeedbackBody, sendFeedback } from "./feedback";

it("sends only the trimmed, clamped fields", () => {
  const body = buildFeedbackBody({ message: `  ${"x".repeat(4100)}  `, email: "  me@example.com ", version: "1.3.17", os: "Win32" });
  expect([...body.keys()]).toEqual(["message", "email", "version", "os"]);
  expect(body.get("message")).toHaveLength(4000);
  expect(body.get("email")).toBe("me@example.com");
  expect(buildFeedbackBody({ message: "hi", email: "   " }).has("email")).toBe(false);
});

it("a full ASCII message fits the site's 8 KB cap; a long non-Latin one is flagged by size", () => {
  const size = (message: string) => buildFeedbackBody({ message, email: "x".repeat(254), version: "1.3.17", os: "MacIntel" }).toString().length;
  expect(size("x".repeat(4000))).toBeLessThanOrEqual(MAX_BODY_BYTES);
  expect(size("é".repeat(1500))).toBeGreaterThan(MAX_BODY_BYTES);
});

it("posts form-encoded to the site endpoint and resolves on 200", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  await sendFeedback({ message: "hello", version: "1.3.17", os: "MacIntel" }, fetchImpl);
  const [url, init] = fetchImpl.mock.calls[0];
  expect(url).toBe(FEEDBACK_URL);
  expect(init.method).toBe("POST");
  expect(init.body).toBeInstanceOf(URLSearchParams); // CORS-simple: no preflight
  expect(init.headers).toBeUndefined();
});

it.each([429, 500, 403])("rejects on HTTP %i", async (status) => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status }));
  await expect(sendFeedback({ message: "hi" }, fetchImpl)).rejects.toThrow(String(status));
});

it("rejects on a network error", async () => {
  await expect(sendFeedback({ message: "hi" }, vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))).rejects.toThrow("Failed to fetch");
});
