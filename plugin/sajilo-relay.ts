/**
 * sajilo-relay.ts - the provider layer of the Sajilo harness.
 *
 * A local OpenAI-compatible proxy that makes any client (the opencode runtime
 * that runs Sajilo, curl, Freebuff BYOK, anything) usable against the
 * opencode.ai free-model gateway.
 *
 * Why this exists (proven by experiment, Nov 2026):
 * The gateway at https://opencode.ai/inference/openai/v1 deterministically
 * 429s ("FreeUsageLimitError") every request unless the request matches an
 * exact whitelist. Mapping the feature space with byte-level probes:
 *
 *   REQUIRED (any of these missing => 429):
 *   1. bun TLS/H2 transport      - curl/python replays of byte-identical
 *                                  captured requests 429; the same bytes sent
 *                                  through bun's fetch (this process) pass.
 *   2. opencode client headers   - User-Agent "opencode/latest/<v>/cli",
 *                                  x-opencode-client, and a session id the
 *                                  gateway already knows (created by a real
 *                                  opencode run here). Fresh random ses_ ids
 *                                  are rejected, so the relay reuses the
 *                                  project's live session id.
 *   3. approved body shape:
 *      agent class  = the harness system prompt AND the full 12-tool set
 *                     (extra tools appended are accepted; missing tools or a
 *                     fake/renamed tools array is rejected)
 *      title class  = system prompt EXACTLY equal to the title-generation
 *                     prompt and NO tools (reply is just a title - useless
 *                     for general chat, so not used here)
 *
 * This plugin rewrites every /openai/v1/chat/completions request into the
 * approved agent shape while preserving the caller's conversation:
 *   - system  <- the Sajilo harness prompt (agent-prompt.txt), with the model
 *                block filled with the model that actually serves the request
 *   - caller's system message(s) are moved into a bracketed note in the first
 *     user message (freebuff/other harness instructions still reach the model)
 *   - tools   <- the 12-tool harness set + caller's tools appended
 *   - session ids / trace ids / UA injected (caller values, if any, win so
 *     real opencode sessions keep their own identity)
 *
 * Endpoints:
 *   POST /openai/v1/<path>  -> https://opencode.ai/inference/openai/v1/<path>
 *   GET  /relay-health                          { ok, hits, upstream }
 * Loopback only. Disable with SAJILO_RELAY_ENABLED=0. Passthrough (no rewrite)
 * for upstream paths other than chat/completions.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

/**
 * Environment lookup. SAJILO_* is canonical; the OPENCODE_* names stay as
 * legacy aliases so an instance that was configured before the rename keeps
 * working untouched.
 */
function env(suffix: string, legacySuffix = suffix): string | undefined {
  return process.env[`SAJILO_${suffix}`] ?? process.env[`OPENCODE_${legacySuffix}`]
}

const ACTIVITY_LOG =
  env("RELAY_ACTIVITY_LOG") ?? "/tmp/sajilo/relay-activity.log"
function logActivity(line: string): void {
  try {
    appendFileSync(ACTIVITY_LOG, line + "\n")
  } catch {
    try {
      mkdirSync("/tmp/opencode", { recursive: true })
      appendFileSync(ACTIVITY_LOG, line + "\n")
    } catch {
      /* diagnostics only */
    }
  }
}

// The plugin wrapper is only used inside the opencode runtime, but this file
// is also imported by the standalone runner (bun), which has no @opencode/plugin
// package. A plain object is all the runtime needs - Plugin.define() is only a
// typing helper.
function define<T>(plugin: T): T {
  return plugin
}

type Ctx = { options?: Record<string, unknown>; [k: string]: unknown }

const PORT = Number(env("RELAY_PORT") ?? 43904)
// Where the relay listens. 127.0.0.1 keeps it on this machine (other local
// agents can still use it). Set it to 0.0.0.0 to serve other machines - but
// then a token is REQUIRED, because the relay spends the account's quota.
const BIND = env("RELAY_BIND") ?? "127.0.0.1"
// Optional bearer token for clients. When set, every request must carry it.
const TOKEN = env("RELAY_TOKEN") ?? ""
// Every path the relay touches is rooted here, so a SECOND instance can run
// side by side with the main one (own pins, own resources, own DB) without
// the two fighting over the same files. the sajilo instance uses
// SAJILO_RELAY_DIR=/root/sajilo/.config/opencode/plugin.
const RELAY_DIR = env("RELAY_DIR") ?? "/root/.sajilo/plugin"
const RESOURCES_DIR = `${RELAY_DIR}/resources`
// Marker written by the rotator while it replaces the tunnel (see
// rotationInProgress below). Per-instance so the sajilo rotator does not mute
// the main relay.
const ROTATE_MARKER =
  env("ROTATE_MARKER") ?? "/root/sajilo/.rotate.inprogress"
// Scratch dir where the mint spawns its opencode run. Per-instance so two
// relays never share a scratch dir.
const MINT_DIR = env("RELAY_MINT_DIR") ?? "/root/sajilo-mint"
// Where the full request/response dumps land (diagnostics, not the activity
// log - that one truncates).
const DUMP_DIR = env("RELAY_DUMP_DIR") ?? "/tmp/sajilo"
// Per-instance runtime upstream override file (the sajilo instance has its own).
const RELAY_UPSTREAM_FILE =
  env("RELAY_UPSTREAM_FILE") ?? "/tmp/sajilo/relay-upstream.txt"
// Runtime-overridable upstream (without restart): if
// /tmp/sajilo/relay-upstream.txt exists and is non-empty, its trimmed
// content replaces the upstream base URL on every reload. Remove the file
// (or truncate) to fall back to the default gateway.
function upstreamBase(): string {
  try {
    const f = readFileSync(RELAY_UPSTREAM_FILE, "utf8").trim()
    if (/^https?:\/\//.test(f)) return f
  } catch {
    /* override not present */
  }
  return env("RELAY_UPSTREAM") ?? "https://opencode.ai/inference/openai"
}
const HOP_KEYS = "host|connection|content-length|transfer-encoding|accept-encoding|keep-alive|upgrade|te|trailers"
const INJECT_KEYS = "user-agent|x-opencode-client|x-opencode-session|x-opencode-session-id|x-session-affinity|x-session-id|x-opencode-project|b3|traceparent|authorization"
// Header fingerprint tightened (Nov 10 2026): the live CLI sends NO b3/
// traceparent and no caller-supplied accept headers. Accept-Encoding broke the
// whitelist fingerprint before; strip anything not in the CLI's exact set.
const STRIP_KEYS = "accept|accept-encoding|accept-language|b3|traceparent|subscription-key|x-api-key|cookie"

const isHop = (k: string) => new RegExp(`^(?:${HOP_KEYS})$`).test(k)
const isInject = (k: string) => new RegExp(`^(?:${INJECT_KEYS})$`).test(k)
const isStrip = (k: string) => new RegExp(`^(?:${STRIP_KEYS})$`).test(k)

const AGENT_PROMPT = readFileSync(
  `${RELAY_DIR}/resources/agent-prompt.txt`,
  "utf8",
).trim()
const AGENT_TOOLS = JSON.parse(
  readFileSync(`${RELAY_DIR}/resources/agent-tools.json`, "utf8"),
) as Array<Record<string, unknown>>

// The free pool, as the runtime's own provider presents it.
const SAJILO_MODEL_LIST: Record<string, { name: string }> = {
  "deepseek-v4.1-flash-free": { name: "DeepSeek V4.1 Flash Free" },
  "glm-5.3-flash-free": { name: "GLM 5.3 Flash Free" },
  "mimo-v2.6-flash-free": { name: "MiMo v2.6 Flash Free" },
  "longcat-2.5-free": { name: "LongCat 2.5" },
  "iceman-free": { name: "Iceman" },
  "inkling-2-small-free": { name: "Inkling 2 Small" },
  "beam-free": { name: "Beam" },
  "flint-40b-free": { name: "Flint 40B" },
  "nemotron-3.5-lightning-free": { name: "Nemotron 3.5 Lightning" },
  "minimax-m3.1-flash-free": { name: "MiniMax M3.1 Flash" },
  "nemotron-3.5-super-vl-free": { name: "Nemotron 3.5 Super VL" },
}

// ---------------------------------------------------------------------------
// The live harness.
//
// The prompt and the tool set are a CONTRACT with the gateway: it recognises
// the agent class by the prompt's skeleton and the tool names. A snapshot of
// them goes stale the moment opencode updates - and a stale spec fails in a
// way that looks exactly like an empty quota window.
//
// So the relay LEARNS the harness instead: every request the opencode runtime
// makes carries its own live prompt and its own live tools (MCP servers
// included). They are captured here, kept next to the instance, and Sajilo's
// own identity and rules are layered on top. An opencode update therefore
// flows through by itself - the next request teaches the relay the new
// harness.
//
// The overlay is resources/sajilo-overlay.md: an "# Identity" block that
// replaces the prompt's first line, and a "# Rules" block that is appended as
// its own section. The gateway accepts both (measured), so this is where
// Sajilo is allowed to be Sajilo.
const OVERLAY_FILE = `${RELAY_DIR}/resources/sajilo-overlay.md`
const SPEC_FILE = `${RESOURCES_DIR}/harness-spec.json`

type HarnessSpec = {
  prompt: string
  tools: Array<Record<string, unknown>>
  capturedAt: string
  source: string
}

function readSpec(): HarnessSpec | null {
  try {
    const s = JSON.parse(readFileSync(SPEC_FILE, "utf8")) as HarnessSpec
    if (typeof s?.prompt === "string" && Array.isArray(s.tools)) return s
  } catch {
    /* no spec yet */
  }
  return null
}

function writeSpec(spec: HarnessSpec): void {
  try {
    writeFileSync(SPEC_FILE, JSON.stringify(spec, null, 2))
  } catch {
    /* diagnostics only */
  }
}

/**
 * The harness prompt's model block, as a template. It is filled in per
 * request with the model that actually serves it, so the agent never claims
 * to be a model it is not.
 */
const MODEL_BLOCK = `# Your Model
- Name: {{MODEL_NAME}}
- Provider ID: {{PROVIDER_ID}}
- Model ID: {{MODEL_ID}}`

/**
 * Replace the runtime's model block with Sajilo's template. The runtime fills
 * in its own block with ITS model; Sajilo fills in its own with the model
 * the relay actually used.
 */
function replaceModelBlock(prompt: string): string {
  if (!prompt.includes("# Your Model")) return prompt
  return prompt.replace(/# Your Model\r?\n(?:- .*\r?\n?)*/g, `${MODEL_BLOCK}\n`)
}

/**
 * Does this prompt look like the opencode agent prompt? Only such prompts are
 * worth learning from - a third-party agent's prompt (Hermes, Cline, ...) must
 * never become Sajilo's harness.
 */
function looksLikeRuntimePrompt(prompt: string): boolean {
  return prompt.includes("# Harness") || prompt.includes("# Code Mode")
}

/**
 * Learn the harness the runtime is actually using. Called with the
 * INCOMING request, before it is rewritten.
 */
function captureLiveHarness(prompt: string, tools: unknown): void {
  if (!prompt || !looksLikeRuntimePrompt(prompt)) return
  const list = Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : []
  if (list.length === 0) return
  const current = readSpec()
  if (current && current.prompt === prompt && current.tools.length === list.length) return
  writeSpec({
    prompt,
    tools: list,
    capturedAt: new Date().toISOString(),
    source: "runtime",
  })
  logActivity(
    `[${new Date().toISOString()}] HARNESS captured from the live runtime (${prompt.length} chars, ${list.length} tools)`,
  )
}

/**
 * Sajilo's layer on top of the live harness: the identity line and the rules.
 */
function applyOverlay(prompt: string): string {
  let overlay = ""
  try {
    overlay = readFileSync(OVERLAY_FILE, "utf8")
  } catch {
    /* no overlay - the prompt goes as it is */
  }
  if (!overlay.trim()) return prompt

  const sections = overlay.split(/^# (Identity|Rules)\s*$/m)
  let out = prompt
  // "# Identity" replaces the first line (the sentence that says who this is).
  const identity = sections[2]?.trim()
  if (identity) {
    const lines = out.split("\n")
    const first = lines.findIndex((l) => l.trim().length > 0)
    if (first >= 0) {
      lines[first] = identity
      out = lines.join("\n")
    }
  }
  // "# Rules" becomes its own section at the end.
  const rules = sections[4]?.trim()
  if (rules) {
    out = `${out.replace(/\s+$/, "")}\n\n# Sajilo\n${rules}\n`
  }
  return out
}

const CLIENT = "cli"
// UA version is part of the client fingerprint. The gateway accepted
// "2.2.6" even on later CLI versions, but make it overridable so a future
// whitelist tightening can be matched without editing the code.
const VERSION = env("RELAY_UA_VERSION") ?? "2.2.6"
// Project id of the account used for the pinned session (matches what the
// CLI sends for that project directory). MUST rotate together with the
// session id: the gateway binds session -> project at admission time.
const PROJECT_FILE = `${RESOURCES_DIR}/live-project.txt`
const PROJECT_FALLBACK = "0581581e6cea524014dea5de9d1d314c6cae1439"

function projectID(): string {
  try {
    const p = readFileSync(PROJECT_FILE, "utf8").trim()
    if (/^[0-9a-f]{40}$/.test(p)) return p
  } catch {
    /* fall through */
  }
  return PROJECT_FALLBACK
}
// Session id that the gateway already accepted; kept as a constant because
// fresh ids are rejected. Rotatable via /root/.config/opencode/plugin/
// resources/live-session.txt when needed (trim trailing whitespace).
const SESSION_FILE = `${RESOURCES_DIR}/live-session.txt`

function sessionID(): string {
  try {
    const s = readFileSync(SESSION_FILE, "utf8").trim()
    if (s.startsWith("ses_")) return s
  } catch {
    /* fall through */
  }
  return "ses_e3c4dddccffefa1fMFnT0oQZo2"
}

function traceIds(): { b3: string; traceparent: string } {
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("")
  const trace = hex(32)
  const span = hex(16)
  return { b3: `${trace}-${span}-1`, traceparent: `00-${trace}-${span}-01` }
}

/**
 * Rewrite an OpenAI chat/completions request body into the approved agent
 * shape, preserving the caller's conversation and extra tools.
 */
function toolName(t: unknown): string | undefined {
  const f = (t as any)?.function
  if (typeof f?.name === "string") return f.name
  const n = (t as any)?.name
  return typeof n === "string" ? n : undefined
}

/**
 * The caller's own prompt carries its own "# Your Model" block. The harness
 * owns the identity, so the duplicate is dropped: with two different model
 * identities in one request the model picks the wrong one.
 */
function stripModelBlock(text: string): string {
  return text.replace(/\r?\n# Your Model\r?\n(?:- .*\r?\n?)*/g, "\n")
}

function transformBody(raw: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw // not JSON; upstream will error; pass through untouched
  }
  const msgs = Array.isArray(parsed.messages) ? [...parsed.messages] : []
  const systems: string[] = []
  const rawSystems: string[] = []
  const rest: Array<Record<string, unknown>> = []
  for (const m of msgs) {
    const role = (m as { role?: string }).role
    if (role === "system" || role === "developer") {
      const c = (m as { content?: unknown }).content
      const text = typeof c === "string" ? c : JSON.stringify(c)
      if (text) {
        rawSystems.push(text)
        systems.push(stripModelBlock(text))
      }
    } else {
      rest.push(m)
    }
  }
  // Learn the harness the runtime is using, BEFORE it is rewritten. The RAW
  // prompt is captured - the model block is replaced later with Sajilo's own
  // template, so the capture stays a faithful copy of the runtime's harness.
  if (rawSystems.length > 0) captureLiveHarness(rawSystems[0], parsed.tools)

  // The live harness if we have one (it follows opencode's own updates),
  // otherwise the shipped snapshot.
  const spec = readSpec()
  const basePrompt = spec?.prompt ?? AGENT_PROMPT
  const baseTools = spec?.tools ?? AGENT_TOOLS

  const rewritten: Array<Record<string, unknown>> = []
  // SAJILO_RELAY_HARNESS=caller keeps the CALLER's own system prompt instead
  // of injecting Sajilo's. The gateway accepts a request with the harness
  // prompt alone, so a third-party agent can bring its own brain - it just
  // has to be the shape the gateway approves.
  if (env("RELAY_HARNESS")?.toLowerCase() === "caller" && systems.length > 0) {
    rewritten.push({ role: "system", content: systems.join("\n\n---\n\n") })
  } else {
    // The live harness with Sajilo's model block, identity and rules on top.
    rewritten.push({
      role: "system",
      content: applyOverlay(replaceModelBlock(basePrompt)),
    })
  }
  if (systems.length && env("RELAY_HARNESS")?.toLowerCase() !== "caller") {
    rewritten.push({
      role: "user",
      content:
        "[HARNESS CONTEXT - follow these instructions for this task]\n" +
        "Tool-use note: the caller's own tools are appended after the built-in " +
        "toolset. When a caller tool matches the user's request, call it by " +
        "name instead of substituting a built-in tool.\n---\n" +
        systems.join("\n\n---\n\n"),
    })
  }
  rewritten.push(...rest)

  // Merge caller tools after the harness toolset, de-duplicating by name so a
  // caller (or our own curl tests) that already includes the harness toolset
  // doesn't send duplicate tool registry entries upstream.
  const seen = new Set<string>()
  for (const t of baseTools) {
    const n = toolName(t)
    if (n) seen.add(n)
  }
  const callerTools = Array.isArray(parsed.tools)
    ? (parsed.tools as Array<Record<string, unknown>>).filter((t) => {
        const n = toolName(t)
        if (n && seen.has(n)) return false
        if (n) seen.add(n)
        return true
      })
    : []
  // The 12-tool set is the gateway's agent-class fingerprint, but it is also
  // ~14 KB of every request - and the free allowance is weight-based. A
  // third-party agent that brings its own toolset can therefore run lean:
  // SAJILO_RELAY_TOOLS=caller drops the harness tools and sends only the
  // caller's. Verified against the gateway: a request with the harness prompt
  // and the caller's tools alone is accepted.
  const lean = env("RELAY_TOOLS")?.toLowerCase() === "caller"
  const mergedTools = lean && callerTools.length > 0 ? callerTools : [...baseTools, ...callerTools]
  if (lean && callerTools.length > 0) {
    logActivity(
      `[${new Date().toISOString()}] TOOLS lean mode: ${callerTools.length} caller tools only (the harness toolset is not appended)`,
    )
  }
  // A third-party agent can only execute the tools IT sent. The harness
  // toolset is in the request (the gateway expects it), so the model can
  // still see it - and a call the caller cannot run breaks the turn. Tell
  // the model to stick to the caller's own tools.
  const harnessNames = new Set(baseTools.map((t) => toolName(t)).filter(Boolean) as string[])
  const foreignTools = callerTools.filter((t) => {
    const n = toolName(t)
    return !!n && !harnessNames.has(n)
  })
  if (foreignTools.length > 0) {
    rewritten[0] = {
      ...rewritten[0],
      content: `${rewritten[0].content}\n\n# Tools\n- The caller of this request supplied its own tools (${foreignTools
        .map((t) => toolName(t))
        .join(", ")}). Use ONLY those - the other tools in this list belong to the harness and the caller cannot run them, so a call to one breaks the turn.`,
    }
  }
  parsed.messages = rewritten
  parsed.tools = mergedTools
  delete parsed.max_tokens
  delete parsed.max_completion_tokens
  // Gateway whitelist (Nov 10 2026) requires upstream streaming. Remember the
  // caller's preference so a non-stream caller can still get a JSON response.
  parsed.stream = true
  parsed.stream_options = { include_usage: true }
  return JSON.stringify(parsed)
}

const callerStreamWants = new WeakMap<Request, boolean>()

// ---- resilient fallbacks (Nov 10 2026) ------------------------------------
// Free limits are rolling windows over per-model pools and per-project
// identity. Freebuff does not retry, so the relay does: rotate models
// transparently, then wait-and-retry, then (last resort) rotate identity in
// the background so the next attempt picks up a fresh pair.
// The free pool is not hand-picked: the gateway publishes the whole
// catalogue at GET /inference/openai/v1/models (which is NOT behind the
// whitelist Ã¢â‚¬â€ a bare curl gets it), and it lists exactly eleven free models.
// Ten of them are text-capable chat models; nemotron-3.5-super-vl-free is
// vision-first, so it stays last. minimax-m3.1-flash-free was missing from
// the original hand-written list even though it is one of the free models.
// The model Sajilo leads with. The harness asks for it by default, and the
// relay falls back to it when a request carries no model at all.
const DEFAULT_MODEL = "deepseek-v4.1-flash-free"

const FREE_POOL_FALLBACK = [
  DEFAULT_MODEL,
  "mimo-v2.6-flash-free",
  "glm-5.3-flash-free",
  "longcat-2.5-free",
  "iceman-free",
  "inkling-2-small-free",
  "beam-free",
  "flint-40b-free",
  "nemotron-3.5-lightning-free",
  "minimax-m3.1-flash-free",
  "nemotron-3.5-super-vl-free",
]

function modelPool(origin: string): string[] {
  return [origin, ...FREE_POOL_FALLBACK.filter((m) => m !== origin)]
}

/**
 * The catalogue served to clients. Only the free pool: the gateway lists 85
 * models but the paid ones cannot be used with the free quota, and a client
 * that picks one just gets a 429.
 */
function freeModelList(): Array<Record<string, unknown>> {
  const ids = [DEFAULT_MODEL, ...FREE_POOL_FALLBACK].filter((m, i, a) => a.indexOf(m) === i)
  return ids.map((id) => ({
    id,
    object: "model",
    created: 0,
    owned_by: "sajilo",
  }))
}

function setModel(body: string, model: string): string {
  try {
    const b = JSON.parse(body) as { model?: string }
    b.model = model
    return JSON.stringify(b)
  } catch {
    return body
  }
}

/**
 * The model the harness asked for. Written by "sajilo model <name>" and read
 * here on EVERY request, so the pin is live: change the model in the harness
 * and the next request upstream uses it, with no restart anywhere.
 */
function modelPin(): string | null {
  try {
    const f = env("RELAY_MODEL_FILE") ?? "/tmp/sajilo/relay-model-override.txt"
    const m = readFileSync(f, "utf8").trim()
    if (m) return m
  } catch {
    /* no pin file Ã¢â‚¬â€ the runtime's own choice is used */
  }
  return null
}

/**
 * The opencode runtime to use for a minted session. Resolved instead of
 * hardcoded, so the rescue chain works on every platform.
 */
function runtimeBin(): string {
  const explicit = env("RELAY_RUNTIME") ?? process.env.OPENCODE_BIN
  if (explicit) return explicit
  return process.platform === "win32" ? "opencode.cmd" : "opencode"
}

/**
 * Fill the harness prompt's "Your Model" block with the model that is
 * actually serving the request. The free pool rotates, so the prompt must
 * not claim a fixed model - the agent has to know what it really is.
 */
function prettyModel(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ")
}

function applyModelIdentity(body: string, model: string): string {
  if (!body.includes("{{MODEL_ID}}")) return body
  try {
    const b = JSON.parse(body) as {
      messages?: Array<{ role?: string; content?: string }>
    }
    const msgs = Array.isArray(b.messages) ? b.messages : []
    for (const m of msgs) {
      if (m.role !== "system" || typeof m.content !== "string") continue
      m.content = m.content
        .split("{{MODEL_NAME}}")
        .join(prettyModel(model))
        .split("{{MODEL_ID}}")
        .join(model)
        .split("{{PROVIDER_ID}}")
        .join("sajilo")
    }
    return JSON.stringify(b)
  } catch {
    return body
  }
}

function mintPair(reason: string): void {
  if (env("RELAY_AUTOMINT") === "0") return
  void (async () => {
    const r = await mintOnce()
    logActivity(
      `[${new Date().toISOString()}] PAIR-MINT kicked (${reason}) -> ${JSON.stringify(r).slice(0, 200)}`,
    )
  })()
}

// Full rescue chain: the free-tier allowance is bound to BOTH legs of the
// identity Ã¢â‚¬â€ the WARP egress (IP bucket, usque tunnel) and the opencode
// session<->project pair. Rotating only one leg often still 429s, so on real
// throttling we do both, in order, in the background:
//   1. warp-rotate.sh --restart-only  (restart the tunnel on the CURRENT
//      registration: the free bucket is keyed on the EXIT IP, and a restart
//      hands out a new one without a re-enrollment; --rotate-only is the
//      fallback when the restart does not bring the tunnel back;
//      flock-serialized across instances; restores the previous registration
//      if re-registering fails, so the tunnel never stays down)
//   2. harvest-session.py --mint     (fresh pair, registered over the new
//      egress so the gateway's session->project binding sticks)
let rescueInFlight = false
let lastRescueAt = 0

/**
 * Experiment switch: allow the rescue chain to skip the WARP egress rotation
 * so the pair-mint leg can be tested in isolation (the open question in
 * VERDICT.md: "does pair-mint alone recover from a drained bucket, or is the
 * egress leg load-bearing?"). Disable with
 *   SAJILO_RELAY_EGRESS_ROTATE=0   (env)
 *   /tmp/sajilo/relay-no-egress-rotate.txt  (file, live-reloadable Ã¢â‚¬â€ the
 *                                              server process env can't be
 *                                              changed without a restart)
 */
function egressRotationEnabled(): boolean {
  try {
    const f = readFileSync("/tmp/sajilo/relay-no-egress-rotate.txt", "utf8").trim()
    if (f) return false
  } catch {
    /* flag file absent -> normal behaviour */
  }
  return env("RELAY_EGRESS_ROTATE") !== "0"
}

function kickRescue(reason: string): boolean {
  if (env("RELAY_AUTOMINT") === "0") return false
  const now = Date.now()
  if (rescueInFlight || now - lastRescueAt < 5 * 60_000) return false
  rescueInFlight = true
  lastRescueAt = now
  const rotateEgress = egressRotationEnabled()
  // The rotator and the rescue log are per-instance: the sajilo instance must
  // rotate ITS OWN tunnel. A hardcoded path meant sajilo's rescue chain
  // rotated the LIVE tunnel.
  //
  // Windows has its own rotator: the opencode-warp stack ships
  // warp-rotate.cmd (--rotate-only), and there is no --restart-only there.
  const isWindows = process.platform === "win32"
  const ROTATOR = isWindows
    ? (env("RELAY_ROTATOR") ??
      `${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin\\warp-rotate.cmd`)
    : (env("RELAY_ROTATOR") ?? "/usr/local/lib/opencode-warp/warp-rotate.sh")
  const RESCUE_LOG =
    env("RELAY_RESCUE_LOG") ?? "/tmp/sajilo/rescue.log"
  const transcript = (line: string) => {
    try {
      mkdirSync(RESCUE_LOG.replace(/[/\\][^/\\]*$/, ""), { recursive: true })
      appendFileSync(RESCUE_LOG, line + "\n")
    } catch {
      /* diagnostics only */
    }
  }
  transcript(
    `--- rescue ${new Date().toISOString()} (${reason}) egress-rotate=${rotateEgress} ---`,
  )

  // The rescue runs natively here - no shell, no quoting, no curl: it is two
  // steps, and this process can do both itself. The old version shelled out to
  // a script, which on Windows meant cmd.exe quoting hell: it failed
  // instantly and never wrote a transcript.
  void (async () => {
    try {
      if (rotateEgress) {
        // Rotate the egress: a new exit IP is a new quota bucket. Restart
        // first on unix (cheap, keeps the working account); Windows has only
        // --rotate-only, which replaces the WARP registration.
        const attempts = isWindows
          ? [[ROTATOR, "--rotate-only"]]
          : [
              [ROTATOR, "--restart-only"],
              [ROTATOR, "--rotate-only"],
            ]
        for (const attempt of attempts) {
          const [bin, ...args] = attempt
          const proc = Bun.spawn(
            isWindows ? ["cmd.exe", "/c", bin, ...args] : ["bash", bin, ...args],
            { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
          )
          const out = await proc.exited
          let tail = ""
          try {
            tail = (await new Response(proc.stdout).text()).slice(-400)
          } catch {
            /* ignore */
          }
          transcript(`${bin} ${args.join(" ")} -> rc=${out} ${tail.trim()}`)
          if (out === 0) break
        }
      } else {
        transcript("egress rotation SKIPPED (experiment mode: pair-mint only)")
      }

      // Mint a fresh session/project pair through the relay's own endpoint.
      const minted = await fetch(`http://127.0.0.1:${PORT}/relay-mint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const body = await minted.text()
      transcript(`mint -> ${minted.status} ${body.slice(0, 300)}`)
      logActivity(
        `[${new Date().toISOString()}] RESCUE finished (${reason}): the egress was rotated and a fresh pair was minted`,
      )
    } catch (e) {
      transcript(`rescue failed: ${String(e).slice(0, 300)}`)
    } finally {
      rescueInFlight = false
    }
  })()
  logActivity(
    `[${new Date().toISOString()}] RESCUE kicked (${reason}): ` +
      `${rotateEgress ? "warp rotate + pair re-mint" : "pair re-mint only (egress rotation disabled)"}`,
  )
  return true
}

// ---- egress mode ----------------------------------------------------------
// The relay's upstream fetch rides the process-wide HTTPS_PROXY, i.e. the WARP
// tunnel (claim 3). Measured on Bun 1.4.4 inside this process: the default
// fetch goes out via the tunnel (104.28.196.82), `proxy: ''` and
// `proxy: undefined` still tunnel, and only NO_PROXY bypasses it (27.34.64.67
// = the device's native egress).
//
// The native egress is an INDEPENDENT quota bucket (VERDICT claim 5: the
// quota unit is the egress IP, not the session pair), so the relay can run
// proxy-free and use the tunnel only as the on-demand second bucket.
//
// Flag file /tmp/sajilo/relay-direct-egress.txt -> the relay's upstream
// fetch bypasses the proxy. Remove it to go back to the tunnel.
//
// The bypass is applied around the fetch call only (NO_PROXY is restored
// immediately after the call), so the opencode server's own provider calls
// are not parked on the native egress.
const DIRECT_EGRESS_FLAG =
  env("RELAY_DIRECT_EGRESS_FLAG") ?? "/tmp/sajilo/relay-direct-egress.txt"

function directEgressEnabled(): boolean {
  try {
    return readFileSync(DIRECT_EGRESS_FLAG, "utf8").trim().length > 0
  } catch {
    return false
  }
}

function withHost(list: string, host: string): string {
  const parts = list.split(",").map((x) => x.trim()).filter(Boolean)
  if (!parts.includes(host)) parts.push(host)
  return parts.join(",")
}

/**
 * fetch() with an optional proxy bypass. Bun reads NO_PROXY when the request
 * is issued, so the env is patched around the synchronous call and restored
 * right after Ã¢â‚¬â€ the tunnel stays the default for everything else in the
 * process.
 *
 * forceDirect=true bypasses the proxy even when the direct-egress flag is
 * off: that is the fallback leg of the egress ladder (the device's native
 * egress is an independent quota bucket, so a dead proxy must not kill the
 * request).
 */
function fetchUpstream(
  target: string,
  init: RequestInit,
  forceDirect = false,
): Promise<Response> {
  // A per-instance proxy (the sajilo instance points at its OWN tunnel so a
  // chaos test on it cannot touch the live one). Bun accepts a proxy URL per
  // request, which keeps the two instances fully independent.
  const proxy = env("RELAY_PROXY")
  if (proxy && !forceDirect) {
    return fetch(target, { ...init, proxy } as RequestInit)
  }
  if (!forceDirect && !directEgressEnabled()) return fetch(target, init)
  let host = ""
  try {
    host = new URL(target).hostname
  } catch {
    return fetch(target, init)
  }
  const savedNO = process.env.NO_PROXY
  const savedno = process.env.no_proxy
  const next = withHost(savedNO ?? "", host)
  process.env.NO_PROXY = next
  process.env.no_proxy = next
  try {
    return fetch(target, init)
  } finally {
    if (savedNO === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = savedNO
    if (savedno === undefined) delete process.env.no_proxy
    else process.env.no_proxy = savedno
  }
}

/**
 * The egress ladder for one attempt: the proxied path first, then the
 * device's native egress. When the direct-egress flag is set, the proxy is
 * skipped entirely.
 */
function egressLadder(): Array<"proxy" | "direct"> {
  return directEgressEnabled() ? ["direct"] : ["proxy", "direct"]
}

/**
 * fetch() across the egress ladder. Used by the paths that are not the chat
 * spin loop (the raw passthrough and /debug-send): they used to go straight
 * to the proxy, so a dead proxy turned them into a 502 even though the
 * device's native egress was right there.
 */
async function fetchWithLadder(
  target: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown = null
  for (const egress of egressLadder()) {
    try {
      return await fetchUpstream(target, init, egress === "direct")
    } catch (e) {
      lastError = e
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

const RETRYABLE_STATUS = (s: number) => s === 429 || s >= 500 || s === 402

// A rotation is in flight: the rotator writes this marker while it replaces
// the tunnel. During that window every in-flight request fails with
// ECONNREFUSED, which used to look like "the egress is broken" and made the
// relay kick ANOTHER rotation Ã¢â‚¬â€ rotating the tunnel out from under the
// rotator, in a loop. Respect the marker: don't count those errors, and
// don't kick a rescue while a rotation is running.
// (the per-instance marker is defined at the top of this file)

function rotationInProgress(): boolean {
  try {
    const raw = readFileSync(ROTATE_MARKER, "utf8").trim()
    if (!raw) return false
    const started = Number(raw.split(/\s+/)[0])
    if (!Number.isFinite(started)) return false
    // A rotation takes a few seconds; treat anything started within the last
    // 60 s as "just rotated" so the errors it caused are not counted.
    return Date.now() - started < 60_000
  } catch {
    return false
  }
}

// ---- python-free identity rotation (improvement, Nov 10 2026) --------------
// The free gateway needs a (session_id, project_id) pair minted by a real
// opencode run outside the harness project. This used to shell out to
// harvest-session.py (python3), which not every device has. Now the relay
// does both halves itself, using the bun runtime it already lives in:
//   mint:    `opencode run "<prompt>"` in a scratch dir (real CLI run => the
//            gateway learns the new session), then read the fresh pair from
//            opencode's sqlite via bun:sqlite.
//   harvest: pin the newest session whose directory is not a harness project.
const MINT_PROMPT = "Mint a fresh relay identity: reply with exactly: MINTED"
const MINT_COOLDOWN = 10 * 60_000
// The harness project (/sdcard/Yoyo) is excluded so the relay never borrows
// the live interactive session's identity. Mint dirs are NOT excluded: the
// freshly minted session lives in one of them and must be harvestable.
const EXCLUDED_DIRS = /^\/sdcard\/Yoyo(?:\/|$)/

async function harvestPair(): Promise<{ session: string; project: string } | null> {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(`${process.env.HOME ?? "/root"}/.local/share/opencode/opencode.db`, { readonly: true })
    try {
      const rows = db
        .query(
          "SELECT id, directory, project_id FROM session_v2 " +
            "WHERE id LIKE 'ses_%' ORDER BY time_updated DESC",
        )
        .all() as Array<{ id: string; directory: string; project_id: string | null }>
      for (const r of rows) {
        if (r && r.id.startsWith("ses_") && !EXCLUDED_DIRS.test(r.directory ?? "")) {
          return { session: r.id, project: r.project_id ?? "" }
        }
      }
    } finally {
      db.close()
    }
  } catch (e) {
    logActivity(`[${new Date().toISOString()}] HARVEST sqlite error: ${String(e).slice(0, 200)}`)
  }
  return null
}

async function pinPair(pair: { session: string; project: string }): Promise<void> {
  if (!/^ses_/.test(pair.session) || !/^[0-9a-f]{40}$/.test(pair.project)) {
    throw new Error(`invalid pair: ${pair.session} / ${pair.project}`)
  }
  mkdirSync(RESOURCES_DIR, { recursive: true })
  writeFileSync(`${RESOURCES_DIR}/live-session.txt`, pair.session + "\n")
  writeFileSync(`${RESOURCES_DIR}/live-project.txt`, pair.project + "\n")
}

let mintInFlight = false
let lastMintFinishedAt = 0

/**
 * Mint a fresh session/project pair. Real CLI run (30-90s) + sqlite read.
 * Cooldown 10 min. Returns a report object (also used by the /relay-mint
 * endpoint; Disable at the source with SAJILO_RELAY_AUTOMINT=0).
 */
async function mintOnce(prompt?: string, force = false): Promise<Record<string, unknown>> {
  if (env("RELAY_AUTOMINT") === "0") return { ok: false, skipped: "disabled" }
  if (mintInFlight) return { ok: false, skipped: "in-flight" }
  if (!force && Date.now() - lastMintFinishedAt < MINT_COOLDOWN)
    return { ok: false, skipped: "cooldown" }
  mintInFlight = true
  try {
    // Mint scratch dir lives OUTSIDE /tmp/sajilo/mint-* so the harvester
    // (which filters the harness project) can see the session it creates.
    const dir = `${MINT_DIR}/${Date.now().toString(36)}`
    mkdirSync(dir, { recursive: true })
    // Strip the harness's own session id: the child must mint its OWN session.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "OPENCODE_SESSION_ID" || v === undefined) continue
      env[k] = v
    }
    // The opencode CLI resolves the project directory from PWD, not from the
    // child's cwd. The server process exports PWD=<harness project> (here
    // /sdcard/Yoyo), so an inherited PWD makes the child create its session in
    // the harness project Ã¢â‚¬â€ where the harvester refuses to look. Point PWD at
    // the scratch dir so the minted session lands in its own project.
    env.PWD = dir
    env.OLDPWD = dir
    // --standalone is mandatory: without it `opencode run` attaches to the
    // app's background service, so the new session is created in the SERVICE's
    // project dir (/sdcard/Yoyo) instead of the scratch dir Ã¢â‚¬â€ and the
    // harvester filters that dir out, so the mint could never find its own
    // session. With --standalone the child runs its own server rooted at the
    // scratch dir, so the session id + project id are a fresh, eligible pair.
    //
    // The runtime is resolved, not hardcoded: the old build pointed at the
    // Android lab's /root/.opencode/bin/opencode, which exists nowhere else.
    const bin = runtimeBin()
    const mintArgs = ["run", "--standalone", prompt ?? MINT_PROMPT]
    const cmd =
      process.platform === "win32" && bin.toLowerCase().endsWith(".cmd")
        ? ["cmd.exe", "/c", bin, ...mintArgs]
        : [bin, ...mintArgs]
    const proc = Bun.spawn(cmd, {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env,
    })
    let childTail = ""
    const childOut = proc.stdout.getReader()
    const drain = (async () => {
      try {
        for (;;) {
          const { done, value } = await childOut.read()
          if (done) break
          if (value) childTail = (childTail + new TextDecoder().decode(value)).slice(-800)
        }
      } catch {
        /* diagnostics only */
      }
    })()
    const rc = await Promise.race([
      proc.exited,
      Bun.sleep(150_000).then(() => {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
        return -1
      }),
    ])
    void drain
    const pair = await harvestPair()
    if (pair) {
      await pinPair(pair)
      logActivity(
        `[${new Date().toISOString()}] PAIR-MINT pinned ${pair.session} (rc=${rc}, dir=${dir})`,
      )
      return { ok: true, rc, session: pair.session, project: pair.project, dir }
    }
    logActivity(
      `[${new Date().toISOString()}] PAIR-MINT found no eligible pair (rc=${rc}, dir=${dir}) child=${childTail.slice(-200).replace(/\n/g, " ")}`,
    )
    return { ok: false, rc, error: "no eligible session", child: childTail.slice(-200) }
  } catch (e) {
    logActivity(`[${new Date().toISOString()}] PAIR-MINT failed: ${String(e).slice(0, 200)}`)
    return { ok: false, error: String(e).slice(0, 300) }
  } finally {
    mintInFlight = false
    lastMintFinishedAt = Date.now()
  }
}

/**
 * True when an already-running relay (typically the one owned by another
 * concurrently launched opencode process, e.g. a second
 * `ocm-run-ubuntu.sh launch -p <project>` session) is healthy on `port`.
 * Used to adopt the existing relay instead of dying on EADDRINUSE.
 */
async function healthyRelayOn(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/relay-health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return false
    const j = (await r.json()) as { ok?: boolean }
    return j?.ok === true
  } catch {
    return false
  }
}

/**
 * Which process owns the relay on `port`? The health payload carries the
 * pid, which tells our OWN previous instance (same pid) apart from a
 * different opencode process.
 */
async function relayOwnerPid(port: number): Promise<number | null> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/relay-health`, {
      signal: AbortSignal.timeout(1500),
    })
    if (!r.ok) return null
    const j = (await r.json()) as { pid?: number }
    return typeof j?.pid === "number" ? j.pid : null
  } catch {
    return null
  }
}

let hits = 0
let takeoverTimer: ReturnType<typeof setInterval> | null = null
let watchdogTimer: ReturnType<typeof setInterval> | null = null

/**
 * Stand-by takeover. This process adopted the port because another opencode
 * process owned it. If that owner goes away Ã¢â‚¬â€ its plugin is reloaded, its
 * session ends Ã¢â‚¬â€ nobody would be serving the relay any more, because the
 * adopted server died with its owner. So stand by and take the port over the
 * moment it frees up: the relay must never stay down.
 */
function startTakeover(): void {
  if (takeoverTimer) return
  takeoverTimer = setInterval(async () => {
    if (server) return
    if (await healthyRelayOn(PORT)) return
    try {
      startServer()
      process.stderr.write(
        `[sajilo-relay] took over port ${PORT} (the previous owner went away)\n`,
      )
      // The instance that takes over is the one that must keep watching the
      // tunnel from now on.
      startWatchdog()
      if (takeoverTimer) {
        clearInterval(takeoverTimer)
        takeoverTimer = null
      }
    } catch {
      /* the port is still busy Ã¢â‚¬â€ try again on the next tick */
    }
  }, 750)
  takeoverTimer.unref?.()
}

let server: ReturnType<typeof Bun.serve> | null = null


// The relay server is created by its own function so the STAND-BY instance
// (the one that adopted the port because another opencode process owned it)
// can take the port over the moment the owner goes away. Without this the
// relay went down for good whenever the owning process reloaded its plugin:
// the new instance adopted the old server, the old server was then stopped by
// its cleanup, and nothing was left serving.
function startServer(): void {
      server = Bun.serve({
        port: PORT,
        hostname: BIND,
        idleTimeout: 240,
        maxRequestBodySize: 64 * 1024 * 1024,
      async fetch(req: Request) {
        try {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/relay-health") {
          return Response.json({
            ok: true,
            hits: hits,
            session: sessionID(),
            pid: process.pid,
            port: PORT,
            bind: BIND,
            harness: env("RELAY_HARNESS")?.toLowerCase() === "caller" ? "caller" : "sajilo",
            tools: env("RELAY_TOOLS")?.toLowerCase() === "caller" ? "caller" : "sajilo",
            auth: TOKEN ? "token" : "open",
          })
        }
        // A token, when set, is required on everything but the health probe.
        if (TOKEN && url.pathname !== "/relay-health") {
          const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
          if (got !== TOKEN) {
            return Response.json({ error: "unauthorized" }, { status: 401 })
          }
        }
        if (req.method === "GET" && url.pathname === "/relay-harvest") {
          // Pin the newest eligible session/project pair without minting.
          const pair = await harvestPair()
          if (pair) {
            try {
              await pinPair(pair)
              return Response.json({ ok: true, ...pair })
            } catch (e) {
              return Response.json(
                { ok: false, error: String(e).slice(0, 200), pair },
                { status: 422 },
              )
            }
          }
          return Response.json(
            { ok: false, error: "no eligible session in opencode.db" },
            { status: 404 },
          )
        }
        if (req.method === "POST" && url.pathname === "/relay-mint") {
          let prompt: string | undefined
          try {
            const b = (await req.json()) as { prompt?: string }
            if (typeof b?.prompt === "string") prompt = b.prompt
          } catch {
            /* empty body is fine */
          }
          return Response.json(await mintOnce(prompt))
        }
        // Two ways in, so any OpenAI-compatible client works out of the box:
        //   /openai/v1/...  the canonical path
        //   /v1/...         what every SDK appends to a base_url
        const isOpenAIPath = url.pathname.startsWith("/openai/")
        const isV1Path = url.pathname.startsWith("/v1/")
        if (!isOpenAIPath && !isV1Path) {
          if (req.method === "POST" && url.pathname === "/debug-send") {
            // Raw probe: send the provided body verbatim to
            // https://opencode.ai/inference/openai/v1/chat/completions with
            // the CLI-exact header fingerprint. No transform. No history.
            const raw = await req.text()
            const sess = sessionID()
            const proj = projectID()
            const headers = new Headers()
            headers.set("authorization", "Bearer public")
            headers.set("content-type", "application/json")
            headers.set("user-agent", `opencode/latest/${VERSION}/${CLIENT}`)
            headers.set("x-opencode-client", CLIENT)
            headers.set("x-opencode-project", proj)
            headers.set("x-opencode-session-id", sess)
            headers.set("x-opencode-session", sess)
            headers.set("x-session-affinity", sess)
            headers.set("x-session-id", sess)
            const target = upstreamBase().replace(/\/inference\/openai$/, "") + "/inference/openai/v1/chat/completions"
            try {
              const upstream = await fetchWithLadder(target, { method: "POST", headers, body: raw })
              const text = await upstream.text()
              return new Response(
                JSON.stringify({ status: upstream.status, session: sess, project: proj, body: text }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            } catch (e) {
              return Response.json({ error: String(e).slice(0, 300) }, { status: 502 })
            }
          }
          return Response.json({ error: "use /openai/<path> or /v1/<path>" }, { status: 404 })
        }
        hits++

        // The model catalogue a client asks for. The gateway publishes all 85
        // models, but only the free pool answers within the free quota - the
        // rest just 429. So serve the free pool: a client that picks from
        // this list always works.
        if (req.method === "GET" && url.pathname.endsWith("/models")) {
          return Response.json({ object: "list", data: freeModelList() })
        }

        let body: ReadableStream<Uint8Array> | null = req.body
        let transformed = ""
        const isChat =
          url.pathname.endsWith("/chat/completions") && req.method === "POST"
        if (isChat) {
          const raw = await req.text()
          let wantStream = true
          try {
            wantStream = (JSON.parse(raw) as { stream?: boolean }).stream !== false
          } catch {
            /* treat as streaming intent */
          }
          callerStreamWants.set(req, wantStream)
          transformed = transformBody(raw)
          // Full-body dumps for offline bisecting (the activity log truncates).
          // They land in the instance's own state dir, not in /tmp - on
          // Windows there is no /tmp, so the dumps used to vanish.
          try {
            mkdirSync(DUMP_DIR, { recursive: true })
            writeFileSync(`${DUMP_DIR}/relay-last-incoming.json`, raw)
            writeFileSync(`${DUMP_DIR}/relay-last-transformed.json`, transformed)
            writeFileSync(
              `${DUMP_DIR}/relay-last-meta.txt`,
              `${new Date().toISOString()}\npathname: ${url.pathname}\n` +
                `model: ${(JSON.parse(raw) as { model?: string }).model ?? "?"}\n` +
                `incoming: ${raw.length}B, transformed: ${transformed.length}B\n`,
            )
          } catch {
            /* diagnostics only */
          }
          logActivity(
            `[${new Date().toISOString()}] INCOMING ${url.pathname} (${raw.length}B):\n` +
              `INCOMING-BODY: ${raw.slice(0, 2000)}\n` +
              `TRANSFORMED-BODY: ${transformed.slice(0, 1200)}`,
          )
        }
        const target = upstreamBase() + (isOpenAIPath ? url.pathname.replace(/^\/openai/, "") : url.pathname)

        // Fresh CLI-exact header set per attempt (session/project pins are
        // re-read so a background identity rotation takes effect mid-request).
        const buildHeaders = () => {
          const sess = sessionID()
          const proj = projectID()
          const headers = new Headers()
          headers.set("authorization", "Bearer public")
          headers.set("content-type", "application/json")
          headers.set("user-agent", `opencode/latest/${VERSION}/${CLIENT}`)
          headers.set("x-opencode-client", CLIENT)
          headers.set("x-opencode-project", proj)
          headers.set("x-opencode-session-id", sess)
          headers.set("x-opencode-session", sess)
          headers.set("x-session-affinity", sess)
          headers.set("x-session-id", sess)
          req.headers.forEach((v, k) => {
            const kk = k.toLowerCase()
            if (isHop(kk) || isInject(kk) || isStrip(kk) || headers.has(kk)) return
            if (v && v.length > 0) headers.set(kk, v)
          })
          return headers
        }
        const headers = buildHeaders()

        // Spin loop: transparent model rotation + backoff + optional identity
        // rotation. Only for chat/completions; everything else stays 1:1.
        let upstream: Response | null = null
        let servedModel = ""
        let finalStatus = 0
        let finalErrBody = "<no response>"
        if (isChat) {
          // The body may not be JSON at all (a hand-written client, a
          // truncated payload). Parsing it used to throw out of the handler
          // and answer with Bun's HTML error page; now the pool still
          // applies and the upstream gets to reject it with a real error.
          // The model the harness asked for. The runtime sends the model the
          // user picked in the TUI (/model) - so THAT wins here, and the relay
          // follows the harness automatically. Only when the request carries
          // no model at all do the pin file and then the default apply.
          let originModel: string | null = null
          try {
            const m = (JSON.parse(transformed) as { model?: string }).model
            if (typeof m === "string" && m) originModel = m
          } catch {
            /* not JSON Ã¢â‚¬â€ fall through to the pin/default */
          }
          if (!originModel) {
            const pinned = modelPin()
            originModel = pinned ?? DEFAULT_MODEL
            logActivity(
              `[${new Date().toISOString()}] MODEL ${originModel} (no model in the request - using the ${pinned ? "pinned" : "default"} model)`,
            )
          } else {
            logActivity(
              `[${new Date().toISOString()}] MODEL ${originModel} (chosen by the harness)`,
            )
          }
          // A UI can offer a model picker whose choice never reaches the
          // request body (Freebuff's `/model` writes settings.freebuffModel,
          // while BYOK keeps sending the connection's model). A wrapper
          // watcher mirrors that pick into a file so the pick still decides
          // what runs upstream. Scoped to Freebuff's own agent prompt so other
          // callers keep full control of their model.
          try {
            const ov = readFileSync(
              env("RELAY_MODEL_FILE") ?? "/tmp/sajilo/relay-model-override.txt",
              "utf8",
            ).trim()
            if (ov && raw.includes("You are Buffy")) {
              originModel = ov
              logActivity(`[${new Date().toISOString()}] MODEL-OVERRIDE ${ov} (Freebuff /model pick)`)
            }
          } catch {
            /* no override file Ã¢â‚¬â€ ignore */
          }
          const pool = modelPool(originModel)
          const CYCLE_WAIT = [0, 20_000, 60_000]
          // Total budget for the whole spin. Without it a fully-drained
          // account (every model 429 on every egress) kept the caller waiting
          // ~5 minutes: 11 models x 3 cycles of slow 429s plus the 20 s + 60 s
          // backoffs. A caller (Freebuff, a CLI, a UI) must never be parked
          // that long Ã¢â‚¬â€ after the budget we answer with the last error and
          // the client retries when it wants to.
          const SPIN_BUDGET_MS = Number(env("RELAY_SPIN_BUDGET_MS") ?? 45_000)
          const spinStarted = Date.now()
          let fetchErrors = 0
          let fatalCount = 0
          outer: for (let cycle = 0; cycle < CYCLE_WAIT.length; cycle++) {
            if (cycle > 0) {
              if (finalStatus === 429) {
                // Whole pool said 429: the identity (egress + pair) is the
                // bottleneck. Full rescue chain in the background; this and
                // later attempts re-read the fresh pins when they land.
                kickRescue("all-pool-429")
              }
              // Never sleep past the budget: the backoff itself was adding up
              // to a minute on top of it (45 s budget, 116 s observed).
              const remaining = SPIN_BUDGET_MS - (Date.now() - spinStarted)
              if (remaining <= 0) {
                logActivity(
                  `[${new Date().toISOString()}] SPIN budget exhausted (${SPIN_BUDGET_MS}ms) before cycle ${cycle} Ã¢â‚¬â€ answering with the last error`,
                )
                break outer
              }
              const wait = Math.min(CYCLE_WAIT[cycle], remaining)
              logActivity(
                `[${new Date().toISOString()}] SPIN cycle ${cycle} (all ${pool.length} models exhausted) Ã¢â‚¬â€ waiting ${wait / 1000}s`,
              )
              await Bun.sleep(wait)
            }
            for (const m of pool) {
              if (Date.now() - spinStarted > SPIN_BUDGET_MS) {
                // If the rescue chain is mid-rotation, the next cycle will hit
                // a FRESH exit IP (the quota is keyed on the exit IP) and
                // therefore a fresh bucket. Giving up now would throw the
                // request away at the exact moment the fix is landing.
                if (rotationInProgress()) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN budget reached while a rotation is in flight Ã¢â‚¬â€ waiting for it`,
                  )
                  await Bun.sleep(10_000)
                  continue
                }
                logActivity(
                  `[${new Date().toISOString()}] SPIN budget exhausted (${SPIN_BUDGET_MS}ms) Ã¢â‚¬â€ answering with the last error`,
                )
                break outer
              }
              const attemptBody = setModel(applyModelIdentity(transformed, m), m)
              let resp: Response | null = null
              // Egress ladder per model: proxied path first, then the
              // device's native egress. A dead proxy (usque down, port
              // drifted, rotation in flight) must not kill the request Ã¢â‚¬â€ the
              // native egress is an independent quota bucket and can still
              // serve it.
              for (const egress of egressLadder()) {
                try {
                  resp = await fetchUpstream(
                    target,
                    {
                      method: "POST",
                      headers: buildHeaders(),
                      // @ts-expect-error bun fetch allows string body
                      body: attemptBody,
                      // @ts-expect-error bun extension: keep the SSE pipe alive
                      duplex: "half",
                    },
                    egress === "direct",
                  )
                  // A 429 from the proxied leg means THAT BUCKET is drained -
                  // not that the model is. The native egress is a different
                  // bucket (its own exit IP) and can still have room, so keep
                  // climbing the ladder instead of answering the 429.
                  if (resp.status === 429 && egress === "proxy" && egressLadder().length > 1) {
                    logActivity(
                      `[${new Date().toISOString()}] SPIN 429 via the proxied egress (${m}): that bucket is drained - trying the native egress`,
                    )
                    try {
                      await resp.body?.cancel()
                    } catch {
                      /* ignore */
                    }
                    resp = null
                    continue
                  }
                  break
                } catch (e) {
                  finalStatus = 0
                  finalErrBody = String(e).slice(0, 300)
                  if (egress === "proxy") {
                    // The proxy leg failed Ã¢â‚¬â€ fall through to the direct leg.
                    logActivity(
                      `[${new Date().toISOString()}] SPIN fetch-error via proxy (${m}): ${finalErrBody} Ã¢â‚¬â€ trying the native egress`,
                    )
                    continue
                  }
                  // Both legs failed for this model.
                  fetchErrors++
                  if (rotationInProgress()) {
                    logActivity(
                      `[${new Date().toISOString()}] SPIN fetch-error during a known rotation (${m}): not counting it`,
                    )
                    fetchErrors = 0
                    continue
                  }
                  logActivity(
                    `[${new Date().toISOString()}] SPIN fetch-error on every egress (${m}): ${finalErrBody}`,
                  )
                  if (fetchErrors >= 3) {
                    // Every egress is unreachable. Do not wait out the
                    // 20 s + 60 s cycles Ã¢â‚¬â€ nothing can succeed while the
                    // network is down, and the caller hangs for ~85 s.
                    // The rescue chain repairs the egress in the background;
                    // the client's retry is faster than our wait.
                    logActivity(
                      `[${new Date().toISOString()}] SPIN aborting: every egress unreachable after ${fetchErrors} fetch errors`,
                    )
                    kickRescue("egress-unreachable")
                    break outer
                  }
                }
              }
              if (!resp) continue
              if (resp.status === 200) {
                upstream = resp
                servedModel = m
                if (m !== originModel) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN fallback used: ${originModel} -> ${m}`,
                  )
                }
                // Say plainly which model answered. The relay rotates under the
                // hood, so the model the client asked for is not always the one
                // that replied - and "which model was that?" is the first
                // question anyone asks when the answers feel different.
                logActivity(
                  `[${new Date().toISOString()}] SERVED ${m}` +
                    `${m === originModel ? " (as requested)" : ` (rotated from ${originModel})`}`,
                )
                break outer
              }
              const errBody = await resp.text().catch(() => "<unreadable>")
              finalStatus = resp.status
              finalErrBody = errBody
              logActivity(
                `[${new Date().toISOString()}] SPIN ${resp.status} on ${m} (of ${pool.length}): ${errBody.slice(0, 200)}`,
              )
              if (RETRYABLE_STATUS(resp.status)) continue
              // Not retryable (e.g. 400 fingerprint error): the request shape
              // is what the gateway disliked, so trying every model and
              // every cycle only burns the caller's time (one malformed body
              // used to cost the full 80 s of backoff and then time out on
              // the client). Give it ONE more model in case the complaint is
              // model-specific, then stop and report the real error.
              fatalCount++
              logActivity(
                `[${new Date().toISOString()}] SPIN ${resp.status} is not retryable (${fatalCount}/2) Ã¢â‚¬â€ ${fatalCount >= 2 ? "giving up on this body" : "trying one more model"}`,
              )
              if (fatalCount >= 2) break outer
            }
          }
        } else {
          try {
            upstream = await fetchWithLadder(target, {
              method: req.method,
              headers,
              body,
              // @ts-expect-error bun extension: keep the SSE pipe alive
              duplex: "half",
            })
          } catch (e) {
            finalStatus = 502
            finalErrBody = String(e).slice(0, 300)
          }
        }

        try {
          const respHeaders = new Headers()
          if (upstream) {
            upstream.headers.forEach((v, k) => {
              if (!isHop(k.toLowerCase()) && k.toLowerCase() !== "content-encoding") {
                respHeaders.set(k, v)
              }
            })
            logActivity(
              `[${new Date().toISOString()}] UPSTREAM ${upstream.status} ${target}` +
                ` (incoming ${url.pathname})`,
            )
            // Tell the client which model actually answered. The response body
            // carries the upstream's model id, but a header is easier to spot
            // (curl -i, an SDK's response headers, a proxy log).
            if (servedModel) respHeaders.set("x-sajilo-model", servedModel)
          } else {
            logActivity(
              `[${new Date().toISOString()}] UPSTREAM ${finalStatus} ${target}` +
                ` (incoming ${url.pathname}, spin exhausted in chat path)`,
            )
          }
          const wantStream = callerStreamWants.get(req) ?? true
          if (!upstream || upstream.status !== 200) {
            if (upstream) await upstream.text().catch(() => "")
            logActivity(
              `[${new Date().toISOString()}] UPSTREAM-ERROR-BODY ${finalStatus}: ${finalErrBody.slice(0, 1200)}`,
            )
            return new Response(finalErrBody, {
              status: upstream?.status ?? (finalStatus || 502),
              headers: upstream ? respHeaders : { "content-type": "application/json" },
            })
          }
          if (wantStream) {
            return new Response(upstream.body, {
              status: upstream.status,
              headers: respHeaders,
            })
          }
          // Caller wanted a non-stream JSON completion; the gateway only does
          // SSE, so reassemble the stream into a chat.completion object.
          const chunks: Array<{ choices?: any[]; usage?: any; [k: string]: any }> = []
          try {
            const reader = upstream.body!.getReader()
            const dec = new TextDecoder()
            let buf = ""
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              for (const line of buf.split("\n")) {
                buf = buf.slice(line.length + 1)
                const t = line.trim()
                if (!t.startsWith("data:")) continue
                const payload = t.slice(5).trim()
                if (payload === "[DONE]") continue
                try {
                  chunks.push(JSON.parse(payload))
                } catch {
                  /* partial line or keep-alive noise */
                }
              }
            }
          } catch (e) {
            logActivity(`[${new Date().toISOString()}] SSE-COLLECT-ERROR ${String(e).slice(0, 200)}`)
          }
          let text = ""
          let toolCalls: Array<Record<string, unknown>> | undefined
          let reasoning: string | undefined
          let usage: unknown
          let lastObj: { model?: string; created?: number; id?: string } = {}
          for (const ch of chunks) {
            if (ch.usage) usage = ch.usage
            if (ch.id) lastObj = ch
            const delta = ch.choices?.[0]?.delta
            if (!delta) continue
            if (typeof delta.content === "string") text += delta.content
            else if (Array.isArray(delta.content))
              for (const part of delta.content)
                if (part?.type === "text" || typeof part?.text === "string") text += part.text
            if (typeof delta.reasoning_content === "string" || typeof (delta as any).reasoning === "string")
              reasoning = (reasoning ?? "") + (delta.reasoning_content ?? (delta as any).reasoning)
            if (Array.isArray(delta.tool_calls))
              for (const tc of delta.tool_calls) {
                const idx = (tc.index as number) ?? 0
                toolCalls = toolCalls ?? []
                while (toolCalls.length <= idx)
                  toolCalls.push({ id: "", type: "function", function: { name: "", arguments: "" } })
                const acc = toolCalls[idx] as any
                if (tc.id) acc.id = tc.id
                if (tc.function?.name) acc.function.name += tc.function.name
                if (tc.function?.arguments) acc.function.arguments += tc.function.arguments
              }
          }
          const completion: Record<string, unknown> = {
            id: lastObj.id ?? "chatcmpl-relay-nostream",
            object: "chat.completion",
            created: typeof lastObj.created === "number" ? lastObj.created : Math.floor(Date.now() / 1000),
            model: lastObj.model ?? "unknown",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: text,
                  ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
                  ...(reasoning ? { reasoning_content: reasoning } : {}),
                },
                finish_reason: toolCalls?.length ? "tool_calls" : "stop",
              },
            ],
            ...(usage ? { usage } : {}),
          }
          logActivity(
            `[${new Date().toISOString()}] NONSTREAM-JSON assembled (${text.length}B text, ${toolCalls?.length ?? 0} toolCalls)`,
          )
          return new Response(JSON.stringify(completion), {
            status: 200,
            headers: {
              "content-type": "application/json",
              ...(servedModel ? { "x-sajilo-model": servedModel } : {}),
            },
          })
        } catch (e) {
          logActivity(`[${new Date().toISOString()}] FETCH-ERROR ${target}: ${String(e).slice(0, 300)}`)
          return Response.json(
            { error: "sajilo-relay: upstream fetch failed", detail: String(e).slice(0, 300) },
            { status: 502 },
          )
        }
        } catch (e) {
          // A throw anywhere in the handler used to escape to Bun's default
          // error page: an HTML 500 that looks like the opencode web app and
          // hides the real cause. Catch it here, log the stack, answer JSON.
          logActivity(
            `[${new Date().toISOString()}] HANDLER-ERROR ${String(e).slice(0, 300)} ` +
              `stack=${(e as { stack?: string })?.stack?.slice(0, 800) ?? "n/a"}`,
          )
          return Response.json(
            { error: "sajilo-relay: handler failed", detail: String(e).slice(0, 300) },
            { status: 500 },
          )
        }
      },
      })
}
/**
 * Start the relay. Callable from the opencode runtime (as the plugin below)
 * and from the standalone runner (bin/sajilo-relay.ts), so the provider can
 * live without a TUI.
 */
/**
 * Point the runtime at THIS relay without touching the rest of the user's
 * config.
 *
 * The config file belongs to the user: it is where MCP servers, permissions,
 * agents and commands live. The launcher used to overwrite it on every start,
 * which wiped all of that. The provider and the model are merged IN instead -
 * the user's keys are preserved, and only ours are set.
 *
 * JSONC comments and trailing commas are tolerated: the file is parsed as
 * JSONC, and if it cannot be parsed the config is left exactly as it is.
 */
function mergeRuntimeConfig(port: number): void {
  const dir = `${process.env.HOME ?? ""}/.config/opencode`
  const candidates = [`${dir}/opencode.json`, `${dir}/opencode.jsonc`]
  const file = candidates.find((f) => {
    try {
      return existsSync(f)
    } catch {
      return false
    }
  })
  if (!file) {
    logActivity(
      `[${new Date().toISOString()}] CONFIG no config file found in ${dir} (looked for opencode.json and opencode.jsonc)`,
    )
    return
  }

  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return
  }
  // Strip a UTF-8 BOM: opencode's parser rejects the whole file when one is
  // there, and Windows editors love to add them.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  let cfg: Record<string, unknown>
  try {
    // JSONC -> JSON: drop line comments and trailing commas.
    const stripped = raw
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1")
    cfg = JSON.parse(stripped) as Record<string, unknown>
  } catch {
    logActivity(
      `[${new Date().toISOString()}] CONFIG ${file} is not valid JSON/JSONC - left untouched`,
    )
    return
  }

  const model = readModelPin()
  const which = (env("RELAY_PROVIDER") ?? "sajilo").toLowerCase()
  if (which === "none") {
    // "direct": the runtime talks to the gateway without the relay. Leave the
    // user's config exactly as it is.
    return
  }
  const providerId = which === "opencode" ? "opencode" : "sajilo"
  const providerName = providerId === "opencode" ? "OpenCode" : "Sajilo"
  const provider: Record<string, unknown> = {
    ...(typeof cfg.provider === "object" && cfg.provider ? (cfg.provider as Record<string, unknown>) : {}),
    [providerId]: {
      npm: "@ai-sdk/openai-compatible",
      name: providerName,
      options: { baseURL: `http://127.0.0.1:${port}/openai/v1` },
      models: SAJILO_MODEL_LIST,
    },
  }
  const before = JSON.stringify(cfg)
  cfg.provider = provider
  if (model) cfg.model = `${providerId}/${model}`
  if (before === JSON.stringify(cfg)) return
  try {
    writeFileSync(file, JSON.stringify(cfg, null, 2))
    logActivity(
      `[${new Date().toISOString()}] CONFIG merged the sajilo provider into ${file} (the rest of your config is untouched)`,
    )
  } catch (e) {
    logActivity(`[${new Date().toISOString()}] CONFIG merge failed: ${String(e).slice(0, 200)}`)
  }
}

function readModelPin(): string {
  // The pin lives in the INSTANCE's state dir, not under HOME (HOME is the
  // instance's home). SAJILO_ROOT is the instance root.
  const root = process.env.SAJILO_ROOT ?? `${process.env.HOME ?? ""}/..`
  try {
    const m = readFileSync(`${root}/state/model.txt`, "utf8").trim()
    if (m && m !== "auto") return m
  } catch {
    /* no pin file - the default model applies */
  }
  // Same default the launcher uses, so the runtime and the relay always agree.
  return DEFAULT_MODEL
}

export async function startRelay(): Promise<void> {
  {
    if (env("RELAY_ENABLED", "BUN_RELAY") === "0") return
    if (server) return

    // Adopt-or-degrade: another opencode process may already own the port
    // with a healthy relay. Binding again would throw "Failed to start
    // server. Is port 43904 in use?" and deactivate the plugin in THIS
    // process. The relay is stateless across processes (it re-reads the
    // live-session/live-project pin files on every request), so adopting
    // is lossless: this process just talks to the existing relay as a client.
    //
    // BUT: on a plugin reload the port can still be held by OUR OWN previous
    // instance (same pid). Adopting it would be a trap Ã¢â‚¬â€ the old server is
    // then stopped by its cleanup and nothing is left serving, which is how
    // the relay used to go down (connection refused) after every reload.
    // In that case wait for the old server to release the port and bind.
    if (await healthyRelayOn(PORT)) {
      const owner = await relayOwnerPid(PORT)
      if (owner !== null && owner !== process.pid) {
        process.stderr.write(
          `[sajilo-relay] port ${PORT} already served by another opencode process (pid ${owner}); adopting existing relay and standing by for takeover\n`,
        )
        startTakeover()
        // Even as the stand-by we must watch the tunnel: this instance may
        // take the port over after the owner dies, and it is the only one
        // left running at that point. Without this the tunnel silently stops
        // being repaired after the first server restart.
        startWatchdog()
        return
      }
      process.stderr.write(
        `[sajilo-relay] port ${PORT} still held by our previous instance (pid ${process.pid}); waiting for it to release\n`,
      )
      // opencode's plugin activation has a HARD 5 s budget: if setup() has
      // not resolved by then, every location-scoped API answers 503
      // "Location plugins did not finish activating". So the wait here is
      // deliberately short Ã¢â‚¬â€ the stand-by takeover (startTakeover) binds the
      // port as soon as it frees up, without blocking the activation.
      for (let i = 0; i < 5; i++) {
        await Bun.sleep(250)
        if (!(await healthyRelayOn(PORT))) break
      }
      if (await healthyRelayOn(PORT)) {
        // Still held: hand over to the stand-by takeover instead of waiting.
        startTakeover()
        return
      }
    }

    // Serving other machines without a token would hand the account's free
    // quota to the whole network. Refuse rather than leak.
    const loopback = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1"
    if (!loopback && !TOKEN) {
      process.stderr.write(
        `[sajilo-relay] refusing to bind ${BIND} without a token. Set SAJILO_RELAY_TOKEN, or SAJILO_RELAY_BIND=127.0.0.1 to keep it local.\n`,
      )
      return
    }

    // Point the runtime at this relay, keeping the user's config intact.
    mergeRuntimeConfig(PORT)

    try {
      startServer()
    } catch (e) {      // The 1.5s health probe and the bind are not atomic: the other process
      // may claim the port in between. Re-check once; if a healthy relay is
      // there, adopt it, otherwise degrade to a quiet no-op instead of
      // killing plugin activation with EADDRINUSE.
      if (await healthyRelayOn(PORT)) {
        process.stderr.write(
          `[sajilo-relay] lost bind race for port ${PORT}; adopting existing relay\n`,
        )
        startTakeover()
        startWatchdog()
        return
      }
      const msg = e instanceof Error ? e.message : String(e)
      if (/in use|EADDRINUSE/i.test(msg)) {
        process.stderr.write(
          `[sajilo-relay] port ${PORT} unavailable and no healthy relay found; degrading (no local relay in this process): ${msg}\n`,
        )
        startWatchdog()
        return
      }
      throw e
    }
    await Bun.sleep(50)
    process.stderr.write(`[sajilo-relay] listening on http://127.0.0.1:${PORT}\n`)
    startWatchdog()

// Proactive tunnel watchdog: probe the WARP egress every few minutes and
// repair it from a cold start if it is down Ã¢â‚¬â€ independent of traffic, so
// "start at any point works automatically". Cheap when healthy (probe
// pass = no-op). The cooldown lives inside the script. Disable with
// SAJILO_RELAY_WATCHDOG=0.
//
// It is started from EVERY path (bind, adopt, takeover) on purpose: the
// instance that takes the port over after a server restart must also keep
// watching the tunnel, otherwise the tunnel silently stops being repaired
// after the first restart.
function startWatchdog(): void {
  if (watchdogTimer) return
  if (env("RELAY_WATCHDOG") === "0") return
  // The watchdog keeps the egress alive. On unix that is the usque tunnel
  // watchdog; on Windows the opencode-warp stack ships probe.cmd, which checks
  // the WARP egress the same way. Pointing it at the unix path here meant the
  // spawn failed every three minutes and filled the log with noise.
  const isWindows = process.platform === "win32"
  const WATCHDOG = isWindows
    ? (env("RELAY_WATCHDOG") ??
      `${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin\\probe.cmd`)
    : (env("RELAY_WATCHDOG") ?? "/usr/local/lib/opencode-warp/tunnel-watchdog.sh")
  if (!existsSync(WATCHDOG)) {
    logActivity(
      `[${new Date().toISOString()}] WATCHDOG not present (${WATCHDOG}) - the egress is not being watched`,
    )
    return
  }
  let watchdogBusy = false
  const watchdogTick = () => {
    if (watchdogBusy) return
    watchdogBusy = true
    try {
      const proc = isWindows
        ? Bun.spawn(["cmd.exe", "/c", WATCHDOG], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          })
        : Bun.spawn(["bash", WATCHDOG], {
            stdout: "ignore",
            stderr: "ignore",
            stdin: "ignore",
          })
      proc.unref()
      proc.exited
        .then((rc) => {
          if (rc !== 0) {
            logActivity(`[${new Date().toISOString()}] WATCHDOG repair attempted rc=${rc}`)
          }
        })
        .catch(() => {})
    } catch (e) {
      logActivity(`[${new Date().toISOString()}] WATCHDOG spawn failed: ${String(e).slice(0, 200)}`)
    }
    watchdogBusy = false
  }
  // First tick after a grace period (serve startup can be noisy), then
  // every 3 minutes for the life of the server.
  void Bun.sleep(90_000).then(watchdogTick)
  watchdogTimer = setInterval(watchdogTick, 3 * 60_000)
  watchdogTimer.unref?.()
}

    return async () => {
      try {
        server?.stop(true)
      } catch {
        /* ignore */
      }
      server = null
      if (takeoverTimer) {
        clearInterval(takeoverTimer)
        takeoverTimer = null
      }
    }
  }
}

/** The opencode plugin wrapper. */
export default define({
  id: "local.sajilo-relay",
  async setup(_ctx: Ctx) {
    await startRelay()
  },
})
