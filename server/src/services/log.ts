/**
 * One log line with its time (review a8-engineering:autopilot-decisions-
 * invisible: the server's log lines carried no time, so a decision in the
 * container log could not be placed — "when did it stop selling?"). Umbrel's
 * log viewer shows the lines as the app writes them.
 */
export function logLine(level: "info" | "warn" | "error", text: string): void {
  const line = `${new Date().toISOString()} ${text}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** A line that already starts with its time (logLine's). */
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z /;

/**
 * Every log line of the process with its time: the console's log, warn and
 * error get the time put in front of a text line that doesn't carry one yet
 * (logLine's lines do). The app's many log lines had none (review a8), and
 * a decision or an error in the container log could not be placed. Called
 * once, at start-up (index.ts); `target` is the console (a test passes its
 * own).
 */
export function timestampConsole(target: Pick<Console, "log" | "warn" | "error"> = console): void {
  for (const level of ["log", "warn", "error"] as const) {
    const write = target[level].bind(target);
    target[level] = (...args: unknown[]) => {
      const [first, ...rest] = args;
      if (typeof first === "string" && !STAMPED.test(first)) write(`${new Date().toISOString()} ${first}`, ...rest);
      else if (typeof first !== "string") write(new Date().toISOString(), ...args);
      else write(...args);
    };
  }
}
