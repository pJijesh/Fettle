/** Runs the background tick (reminders, waiting-list offer expiry, outbox delivery) every 30 seconds in the app process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __ctpTimer?: ReturnType<typeof setInterval> };
  if (g.__ctpTimer || process.env.DISABLE_BACKGROUND_TICK === "1") return;
  const { getPlatform } = await import("./lib/app");
  g.__ctpTimer = setInterval(() => {
    getPlatform()
      .tick()
      .catch((err) => console.error("background tick failed", err));
  }, 30_000);
  g.__ctpTimer.unref?.();
}
