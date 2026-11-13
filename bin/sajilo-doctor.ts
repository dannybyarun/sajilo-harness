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

// --- the live harness -------------------------------------------------------
// The relay learns the harness the runtime is actually using, so an opencode
// update flows through by itself. Report how fresh that capture is.
console.log("\nlive harness")
try {
  const specPath = join(PLUGIN_DIR, "resources", "harness-spec.json")
  if (existsSync(specPath)) {
    const spec = JSON.parse(readFileSync(specPath, "utf8"))
    const age = Math.round((Date.now() - Date.parse(spec.capturedAt)) / 1000)
    ok(`captured from the runtime (${spec.prompt.length} chars, ${spec.tools.length} tools, ${age}s ago)`)
    if (age > 30 * 24 * 3600) {
      warn("the capture is old - run a sajilo session once so the relay can refresh it")
    }
    if (!spec.prompt.includes("# Harness")) {
      warn("the captured prompt does not look like the runtime's own - the gateway may reject it")
    }
  } else {
    warn("no live capture yet - run a sajilo session once and the relay learns the harness")
  }
  const overlay = join(PLUGIN_DIR, "resources", "sajilo-overlay.md")
  if (existsSync(overlay)) {
    const o = readFileSync(overlay, "utf8")
    if (o.includes("# Identity")) ok("overlay: identity present")
    else warn("the overlay has no '# Identity' block - the harness keeps the runtime's own name")
    if (o.includes("# Rules")) ok("overlay: rules present")
  } else {
    warn("no overlay - Sajilo has no identity of its own yet")
  }
} catch (e) {
  warn(`live harness unreadable: ${e}`)
}

// --- the egress -------------------------------------------------------------
// The free allowance is keyed on the exit IP, so the egress matters: a second
// egress is a second bucket.
console.log("\negress")
// The relay's proxied leg is whatever proxy it will ACTUALLY use: the
// explicit SAJILO_RELAY_PROXY, else the ambient HTTPS_PROXY/HTTP_PROXY that
// Bun's fetch honours. Checking only the env var used to say "no proxied
// leg" on a machine whose ambient proxy WAS the Cloudflare WARP proxy
// (warp-svc.exe on 127.0.0.1:40000) - and that answer decides whether the
// instance has one bucket or two.
const explicitProxy =
  process.env.SAJILO_RELAY_PROXY ?? process.env.OPENCODE_RELAY_PROXY ?? ""
const ambientProxy =
  process.env.HTTPS_PROXY ??
  process.env.https_proxy ??
  process.env.HTTP_PROXY ??
  process.env.http_proxy ??
  ""
const proxy = explicitProxy || ambientProxy
const directProxy =
  process.env.SAJILO_RELAY_DIRECT_PROXY ?? process.env.OPENCODE_RELAY_DIRECT_PROXY ?? ""
const TRACE = "https://www.cloudflare.com/cdn-cgi/trace"

// The direct exit: the second bucket. Measured through the direct proxy (an
// explicit proxy that connects with a raw socket - the opencode-warp stack's
// egress-proxy.py with --upstream direct) when one is configured. The old
// NO_PROXY bypass cannot be used for this: Bun < 1.4 ignores NO_PROXY
// entirely, so the "direct" leg came out of the same exit IP as the tunnel.
async function directExit(): Promise<{ ip?: string; warp?: string; how: string }> {
  if (directProxy) {
    try {
      const r = await fetch(TRACE, {
        proxy: directProxy,
        signal: AbortSignal.timeout(8000),
      } as RequestInit)
      const t = await r.text()
      return {
        ip: /ip=([^\n\r]+)/.exec(t)?.[1],
        warp: /warp=(\w+)/.exec(t)?.[1],
        how: directProxy,
      }
    } catch (e) {
      return { how: directProxy }
    }
  }
  // No direct proxy: the NO_PROXY bypass. Works on Bun >= 1.4 only.
  const savedNO = process.env.NO_PROXY
  const savedno = process.env.no_proxy
  const host = new URL(TRACE).hostname
  const next = `${savedNO ?? ""},${host}`.replace(/^,/, "")
  process.env.NO_PROXY = next
  process.env.no_proxy = next
  try {
    const r = await fetch(TRACE, { signal: AbortSignal.timeout(8000) })
    const t = await r.text()
    return {
      ip: /ip=([^\n\r]+)/.exec(t)?.[1],
      warp: /warp=(\w+)/.exec(t)?.[1],
      how: "the NO_PROXY bypass",
    }
  } catch {
    return { how: "nothing" }
  } finally {
    if (savedNO === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = savedNO
    if (savedno === undefined) delete process.env.no_proxy
    else process.env.no_proxy = savedno
  }
}

let proxiedIp = ""
if (proxy) {
  ok(
    `proxied leg: ${proxy}` +
      `${explicitProxy ? " (SAJILO_RELAY_PROXY)" : " (the ambient proxy the relay inherits)"}` +
      ` - a drained bucket can be climbed over`,
  )
  try {
    // Through the proxy explicitly: Bun's fetch would only pick the ambient
    // one up on its own, and the IP printed must be the PROXIED exit.
    const r = await fetch(TRACE, {
      proxy,
      signal: AbortSignal.timeout(8000),
    } as RequestInit)
    const t = await r.text()
    const warp = /warp=(\w+)/.exec(t)?.[1]
    const ip = /ip=([^\n\r]+)/.exec(t)?.[1]
    proxiedIp = ip ?? ""
    ok(`exit through the proxy: ip=${ip ?? "?"} warp=${warp ?? "?"}`)
  } catch (e) {
    warn(`the proxy is set but did not answer: ${e}`)
  }
} else {
  warn("no proxied leg - only one exit IP, so one bucket")
}

const native = await directExit()
if (native.ip) {
  if (proxiedIp && native.ip === proxiedIp) {
    // Same IP on both legs: the tunnel IS the machine's egress (system
    // proxy / TUN), so bypassing the proxy changes nothing. One bucket -
    // and the only way to a new one is to rotate the registration.
    warn(
      `the direct exit is the SAME ip as the proxied one (${native.ip}, warp=${native.warp ?? "?"}) - ` +
        `one bucket only. A new bucket comes from rotating the registration (warp-rotate), ` +
        `or from a direct proxy that leaves the tunnel (SAJILO_RELAY_DIRECT_PROXY).`,
    )
  } else {
    ok(
      `direct exit: ip=${native.ip} warp=${native.warp ?? "off"} - a second bucket (via ${native.how})`,
    )
  }
} else {
  warn(
    `the direct exit could not be measured${directProxy ? ` (${directProxy} did not answer)` : ""} - ` +
      `on Bun < 1.4 NO_PROXY is ignored, so the direct leg stays in the tunnel unless ` +
      `SAJILO_RELAY_DIRECT_PROXY names a proxy that connects directly`,
  )
}

// --- the reset record --------------------------------------------------------
// The relay logs every decision it makes. Summarise the recent ones so the
// state of the free allowance is readable at a glance.
console.log("\nreset record")
try {
  const log = readFileSync(join(STATE, "relay-activity.log"), "utf8")
  const lines = log.split("\n").filter((l) => l.startsWith("["))
  const last = lines.slice(-400)
  const ok200 = last.filter((l) => l.includes("UPSTREAM 200")).length
  const spins = last.filter((l) => l.includes("SPIN 429 on")).length
  const climbs = last.filter((l) => l.includes("trying the native egress")).length
  const resets = last.filter((l) => l.includes("RESET kicked")).length
  const landed = last.filter((l) => l.includes("RESET landed")).length
  const perModel = new Map<string, number>()
  for (const l of last) {
    const m = /SPIN 429 on ([^\s(]+)/.exec(l)
    if (m) perModel.set(m[1], (perModel.get(m[1]) ?? 0) + 1)
  }
  const drained = [...perModel.entries()].sort((a, b) => b[1] - a[1])
  ok(`${ok200} upstream 200s, ${spins} model 429s, ${climbs} ladder climbs, ${landed}/${resets} resets landed (last ${last.length} log lines)`)
  if (drained.length) {
    const top = drained.slice(0, 4).map(([m, n]) => `${m}:${n}`).join(", ")
    warn(`models hitting 429 most: ${top}`)
  } else {
    ok("no model is hitting 429")
  }
  const lastOk = lines.filter((l) => l.includes("UPSTREAM 200")).pop()
  if (lastOk) ok(`last success: ${lastOk.slice(1, 20).replace("Z", "")}`)
  const served = lines.filter((l) => l.includes("] SERVED ")).pop()
  if (served) {
    const m = /] SERVED (\S+)(.*)$/.exec(served)
    ok(`last model that answered: ${m?.[1] ?? "?"}${m?.[2]?.trim() ? ` ${m[2].trim()}` : ""}`)
  }
  // The rule: the caller always gets the model it asked for. A request
  // answered by a different model means the relay rotated - which it must
  // not do any more, because a rotation changes the answer, not the quota.
  //
  // Judge only what the CURRENT build did: the log also holds the history of
  // earlier builds, and an old rotation must not fail today's check. The
  // relay writes a RELAY-START marker when it comes up.
  const lastStart = lines.reduce(
    (acc: number, l: string, i: number) => (l.includes("RELAY-START") ? i : acc),
    -1,
  )
  const since = lastStart >= 0 ? lines.slice(lastStart) : last
  const build = /RELAY-START build=(\S+)/.exec(lines[lastStart] ?? "")?.[1]
  const rotations = since.filter((l) => l.includes("SPIN fallback used")).length
  if (rotations) {
    bad(`${rotations} request(s) were answered by a model the caller did not ask for - the relay must reset the limit, never rotate models`)
  } else {
    ok(
      `every request was answered by the model it asked for` +
        `${build ? ` (build ${build})` : ""}`,
    )
  }
} catch (e) {
  warn(`no reset record yet: ${e}`)
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
      // 429 means one of two things, and they look identical from outside:
      // the free window is empty, or the gateway stopped accepting this
      // harness. The relay's own log tells them apart - if the harness was
      // accepted at least once AFTER the last capture changed, then the
      // harness is fine and the window is what ran out.
      let verdict = "either the free window is empty, or the harness was rejected"
      try {
        const log = readFileSync(join(STATE, "relay-activity.log"), "utf8")
        const lastOk = log.lastIndexOf("UPSTREAM 200")
        const lastChange = Math.max(log.lastIndexOf("HARNESS captured"), log.lastIndexOf("MODEL-PINNED"))
        if (lastOk > lastChange && lastOk > 0) {
          verdict = "the free window is empty - this harness was accepted after its last change"
        }
      } catch {
        /* no log to compare against */
      }
      bad(`gateway answered 429 (${secs}s): ${verdict}`)
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
  const cfgPath = ["opencode.json", "opencode.jsonc"]
    .map((f) => join(HOME_DIR, ".config", "opencode", f))
    .find((p) => existsSync(p))
  if (!cfgPath) {
    warn("no runtime config yet - the relay writes it on the first launch")
  } else {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""))
    const providers = Object.keys(cfg.provider ?? cfg.providers ?? {})
    if (providers.includes("sajilo")) ok(`provider: ${providers.join(", ")}`)
    else warn(`provider is ${providers.join(", ")} - the TUI will print that name instead of Sajilo`)
    if (cfg.model) ok(`model: ${cfg.model}`)
    else warn("no default model in the runtime config")
    const mcp = Object.keys(cfg.mcp?.servers ?? {})
    if (mcp.length) ok(`mcp servers: ${mcp.join(", ")}`)
    else warn("no MCP servers configured")
  }
} catch (e) {
  warn(`runtime config unreadable: ${e}`)
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
