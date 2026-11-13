// sajilo-relay.ts - the relay on its own, without the opencode runtime.
//
//   bun run <root>/bin/sajilo-relay.ts
//
// This is the provider other agents talk to. It is an OpenAI-compatible
// endpoint that rewrites every request into the gateway's approved agent
// class, resets the limit when a model's window is empty (never rotates
// models), survives a dead proxy (the egress ladder), keeps working on a
// request for as long as the client stays connected, and never hands the
// caller a rate-limit error.
//
// It is the same code the runtime loads as a plugin - startRelay() - so the
// behaviour is identical either way.
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const dir = process.env.SAJILO_RELAY_DIR
if (!dir) {
  console.error("sajilo relay: SAJILO_RELAY_DIR is not set - run it through the sajilo launcher")
  process.exit(1)
}

const port = process.env.SAJILO_RELAY_PORT ?? "43915"
const bind = process.env.SAJILO_RELAY_BIND ?? "127.0.0.1"

const mod = await import(pathToFileURL(join(dir, "sajilo-relay.ts")).href)
const cleanup = await mod.startRelay()
if (cleanup) {
  // A clean stop: release the port instead of letting the process be killed
  // with the socket still open.
  const stop = () => {
    void cleanup().finally(() => process.exit(0))
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}

console.log(`sajilo relay listening on http://${bind}:${port}`)
console.log(`  models    : http://${bind}:${port}/v1/models`)
console.log(`  base url  : http://${bind}:${port}/v1`)
if (process.env.SAJILO_RELAY_TOKEN) {
  console.log(`  token     : required (SAJILO_RELAY_TOKEN)`)
}
