// sajilo-doctor.ts - check that the harness and the relay are healthy.
//
//   sajilo doctor
//
// The harness spec is a contract with the gateway: the system prompt has to
// keep the agent-class shape and the 12-tool set has to be there. Get either
// wrong and every request 429s with a message that looks like a quota
// problem. So the doctor probes the gateway with the REAL harness and says
// plainly whether it is still accepted.
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.env.SAJILO_ROOT ?? join(process.env.HOME ?? ".", ".sajilo")
const HOME_DIR = join(ROOT, "home")
const STATE = join(ROOT, "state")
const PLUGIN_DIR = join(HOME_DIR, ".config", "opencode", "plugin")
const PORT = process.env.SAJILO_RELAY_PORT ?? "43914"
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
const ok = (m: string) => console.log(`  ok    ${m}`)
const warn = (m: string) => console.log(`  warn  ${m}`)
const bad = (m: string) => {
  failures++
  console.log(`  FAIL  ${m}`)
}

console.log(`sajilo doctor\n  root: ${ROOT}\n`)

// --- the instance -----------------------------------------------------------
console.log("instance")
for (const [label, p] of [
  ["home", HOME_DIR],
  ["state", STATE],
  ["relay plugin", join(PLUGIN_DIR, "sajilo-relay.ts")],
  ["harness prompt", join(PLUGIN_DIR, "resources", "agent-prompt.txt")],
  ["harness tools", join(PLUGIN_DIR, "resources", "agent-tools.json")],
] as const) {
  if (existsSync(p)) ok(`${label}`)
  else bad(`${label} missing (${p})`)
}

// --- the harness spec's shape ----------------------------------------------
// These sections are what the gateway recognises. If one is gone, the whole
// harness stops being accepted - and the error looks like a quota problem.
console.log("\nharness spec")
try {
  const prompt = readFileSync(join(PLUGIN_DIR, "resources", "agent-prompt.txt"), "utf8")
  const sections = ["# Harness", "# Communication", "# Working in codebases", "# Your Model"]
  const missing = sections.filter((s) => !prompt.includes(s))
  if (missing.length === 0) ok(`sections intact (${sections.length}/${sections.length})`)
  else bad(`sections missing: ${missing.join(", ")} - the gateway will reject this prompt`)
  if (prompt.includes("{{MODEL_ID}}")) ok("model block is a template (filled per request)")
  else warn("model block has no {{MODEL_ID}} template - the agent may claim the wrong model")
  if (/\bYou are Sajilo\b/.test(prompt)) ok("identity: Sajilo")
  else warn("the prompt does not introduce Sajilo")
  const tools = JSON.parse(readFileSync(join(PLUGIN_DIR, "resources", "agent-tools.json"), "utf8"))
  ok(`${tools.length} tools in the spec`)
} catch (e) {
  bad(`harness spec unreadable: ${e}`)
}

// --- the runtime ------------------------------------------------------------
console.log("\nruntime")
const pinned = join(STATE, "sajilo-bin.txt")
if (existsSync(pinned)) {
  const bin = readFileSync(pinned, "utf8").trim()
  if (existsSync(bin)) ok(`runtime: ${bin}`)
  else bad(`the pinned runtime is gone: ${bin}`)
} else {
  warn("no pinned runtime (the launcher will use opencode from PATH)")
}

// --- the relay --------------------------------------------------------------
console.log("\nrelay")
let health: any = null
try {
  const r = await fetch(`${BASE}/relay-health`, { signal: AbortSignal.timeout(4000) })
  health = await r.json()
  ok(`listening on ${BASE} (pid ${health.pid}, ${health.hits} requests served)`)
  ok(`mode: harness=${health.harness} tools=${health.tools} auth=${health.auth}`)
} catch {
  bad(`no relay on ${BASE} - start one with: sajilo relay`)
}

// --- the gateway ------------------------------------------------------------
// The real check: send the instance's own harness upstream and see if the
// gateway accepts it. A 429 here means the harness was rejected, not that
// the quota is empty - and those two look identical from the outside.
console.log("\ngateway")
if (health) {
  const body = {
    model: process.env.SAJILO_DOCTOR_MODEL ?? "deepseek-v4.1-flash-free",
    messages: [{ role: "user", content: "Reply with exactly: SAJILO OK" }],
    stream: false,
  }
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    })
    const text = await r.text()
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (r.status === 200) {
      ok(`harness accepted by the gateway (${secs}s)`)
      let reply = ""
      try {
        reply = JSON.parse(text).choices?.[0]?.message?.content ?? ""
      } catch {}
      if (reply) ok(`model replied: ${reply.slice(0, 60).replace(/\s+/g, " ")}`)
    } else if (r.status === 429) {
      bad(`gateway answered 429 (${secs}s) - either the free window is empty, or the harness was rejected. Compare: sajilo relay --lean serves the same request shape without the harness`)
    } else {
      warn(`gateway answered ${r.status} (${secs}s): ${text.slice(0, 120)}`)
    }
  } catch (e) {
    warn(`probe failed: ${e}`)
  }
}

// --- the identity -----------------------------------------------------------
console.log("\nidentity")
try {
  const cfg = JSON.parse(readFileSync(join(HOME_DIR, ".config", "opencode", "opencode.json"), "utf8"))
  const providers = Object.keys(cfg.provider ?? {})
  if (providers.includes("sajilo")) ok(`provider: ${providers.join(", ")}`)
  else warn(`provider is ${providers.join(", ")} - the TUI will print that name instead of Sajilo`)
  if (cfg.model) ok(`model: ${cfg.model}`)
  else warn("no default model in the runtime config")
} catch (e) {
  warn(`runtime config unreadable: ${e}`)
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
