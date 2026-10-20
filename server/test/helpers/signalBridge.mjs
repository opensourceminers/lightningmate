// Preloaded into a spawned server by tests (node --import …/signalBridge.mjs).
// Windows cannot deliver a signal to another process's handlers — sending one
// terminates the target outright — so the test sends "SIGTERM"/"SIGINT" over
// the IPC channel and this re-emits it as the process signal event, running
// exactly the handler a real signal would.
process.on("message", (msg) => {
  if (msg === "SIGTERM" || msg === "SIGINT") process.emit(msg, msg);
});
