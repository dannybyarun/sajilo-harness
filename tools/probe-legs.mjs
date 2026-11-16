// probe-legs.mjs - which bucket can serve right now?
//
// One relay per egress leg, the rotator disabled (so nothing is perturbed),
// the same harness-shaped request through each. Prints the verdict per leg.
//
//   bun run probe-legs.mjs
import { spawn } from "node:child_process"
import { writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.env.SAJILO_ROOT ?? join(process.env.HOME ?? ".", ".sajilo")
const PLUGIN = join(ROOT, "home", ".config", "opencode", "plugin")
const LEGS = [
  ["proxy (the WARP app)", "40000"],
  ["alt (slot 0)", "40005"],
  ["alt2 (slot 1)", "40006"],
  ["alt3 (slot 2)", "40007"],
]

// A rotator that does nothing: this probe must not change any tunnel.
const noop = join(ROOT, "bin", "noop-rotate.cmd")
writeFileSync(noop, "@echo off\r\nexit /b 0\r\n")

const body = readFileSync(join(ROOT, "state", "relay-last-transformed.json"), "utf8")
const req = join(ROOT, "state", "probe-req.json")
writeFileSync(req, JSON.stringify({ model: "deepseek-v4.1-flash-free", messages: [{ role: "user", content: "reply with exactly: PONG" }] }))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(port, leg) {
  const env = {
    ...process.env,
    HOME: join(ROOT, "home"),
    USERPROFILE: join(ROOT, "home"),
    SAJILO_ROOT: ROOT,
    SAJILO_RELAY_DIR: PLUGIN,
    SAJILO_RELAY_PORT: String(port),
    SAJILO_RELAY_PROXY: `http://127.0.0.1:${leg}`,
    SAJILO_RELAY_PROXY_ALT: "",
    SAJILO_RELAY_PROXY_ALTS: "",
    SAJILO_RELAY_PROXY_ALT_SLOT: "",
    SAJILO_RELAY_PROXY_ALT_SLOTS: "",
    SAJILO_RELAY_DIRECT_PROXY: "http://127.0.0.1:40001",
    SAJILO_RELAY_ROTATOR: noop,
    SAJILO_RELAY_KEEP_WORKING_MS: "15000",
    SAJILO_RELAY_AUTOMINT: "0",
    SAJILO_RELAY_ACTIVITY_LOG: join(ROOT, "state", "probe-legs.log"),
  }
  const child = spawn("bun", ["run", join(ROOT, "bin", "sajilo-relay.ts")], { env, stdio: "ignore" })
  await sleep(4000)
  const started = Date.now()
  let status = "000"
  let retryAfter = ""
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4.1-flash-free", messages: [{ role: "user", content: "reply with exactly: PONG" }] }),
      signal: AbortSignal.timeout(40000),
    })
    status = String(r.status)
    retryAfter = r.headers.get("retry-after") ?? ""
    await r.text()
  } catch (e) {
    status = `ERR ${String(e).slice(0, 60)}`
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  child.kill()
  await sleep(1500)
  console.log(`${leg.padEnd(10)} -> HTTP ${status}  in ${secs}s  retry-after=${retryAfter}`)
}

let port = 43960
for (const [name, leg] of LEGS) {
  console.log(`--- ${name} (127.0.0.1:${leg}) ---`)
  await probe(port++, leg)
}
