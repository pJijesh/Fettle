/** Runs the background tick (reminders, waiting-list offer expiry, outbox delivery) every 30 seconds in the app process. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as unknown as { __ctpTimer?: ReturnType<typeof setInterval> };
  if (g.__ctpTimer || process.env.DISABLE_BACKGROUND_TICK === "1") return;
  const { getPlatform } = await import("./lib/app");
  const { logError, logInfo } = await import("./lib/log");
  g.__ctpTimer = setInterval(() => {
    getPlatform()
      .tick()
      .then((t) => {
        // Say something only when something happened, so a quiet clinic does not fill the log.
        if (Object.values(t).some((n) => n > 0)) logInfo("tick", t);
      })
      .catch((err) => logError("tick", err));
  }, 30_000);
  g.__ctpTimer.unref?.();
}
