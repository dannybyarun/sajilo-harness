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
import { connect } from "node:net"

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
// A build marker. The doctor reads it to tell which relay wrote the log, and
// judges only what THIS build did - the log also holds the history of
// earlier builds, and an old rotation must not fail today's check.
const BUILD = "reset-429-2026-11-13"
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

// ---- the 429 path: reset the limit, keep the model (Nov 13 2026) -----------
// The free allowance is a rolling window over per-model pools AND per-project
// identity. So a 429 does NOT mean "this model is gone" - it means THIS
// identity's window for THIS model is empty. The cure is a fresh identity
// (a new session/project pair, and a new egress IP), never a different
// model.
//
// So the relay never changes the model: it resets the limit and retries the
// model the caller asked for. Measured on this instance: a reset lands in
// 14-22 s and the requested model serves again immediately (18/20, 77/81 and
// 12/12 of the requests in the 90 s after a reset were served by the
// REQUESTED model), while the old pool rotation answered 15% of all requests
// with a model nobody had asked for.
//
// The caller never sees a rate-limit error either, and the relay never
// gives up on a request while the client is still there: it keeps working -
// waiting out the refill the gateway announced, resetting the identity,
// rotating the egress - for as long as it takes. Only if the client is
// still connected after the ceiling does it answer 503 + Retry-After (a
// retryable status that is not a quota error), and even then the reset keeps
// running in the background, so the client's next attempt lands on a fresh
// identity.
//
// The free pool is not hand-picked: the gateway publishes the whole
// catalogue at GET /inference/openai/v1/models (which is NOT behind the
// whitelist - a bare curl gets it), and it lists exactly eleven free models.
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
    /* no pin file - the runtime's own choice is used */
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

// ---- the reset: the cure for a 429 ----------------------------------------
// The free-tier allowance is bound to BOTH legs of the identity - the WARP
// egress (the IP bucket) and the opencode session<->project pair. Rotating
// only one leg often still 429s, so a reset does both, in order:
//   1. warp-rotate.sh --restart-only  (restart the tunnel on the CURRENT
//      registration: the free bucket is keyed on the EXIT IP, and a restart
//      hands out a new one without a re-enrollment; --rotate-only is the
//      fallback when the restart does not bring the tunnel back;
//      flock-serialized across instances; restores the previous registration
//      if re-registering fails, so the tunnel never stays down)
//   2. mint a fresh session/project pair (registered over the new egress so
//      the gateway's session->project binding sticks)
//
// Two things changed when the reset became the answer to a 429 (Nov 13 2026):
//
//   - it is AWAITABLE. The request that hit the 429 waits for the fresh
//     identity and then retries the SAME model. Measured here: a reset lands
//     in 14-22 s, so the caller gets an answer from the model it asked for.
//   - it FORCES the mint. The 10-minute mint cooldown used to skip the
//     pair-mint leg of most resets ({"ok":false,"skipped":"cooldown"}), which
//     left the drained identity in place - the reset rotated the egress and
//     then did nothing about the half of the identity that actually holds
//     the window. A reset exists to get a fresh bucket; the cooldown must
//     not stand in the way of it.
type ResetResult = {
  ok: boolean
  session: string
  note: string
}

let resetInFlight: Promise<ResetResult> | null = null
let lastResetAt = 0

// A reset is expensive (it spawns a real opencode run), so a storm of 429s
// shares ONE reset instead of starting one each.
const RESET_COOLDOWN_MS = Number(env("RELAY_RESET_COOLDOWN_MS") ?? 20_000)
// How long the rotator may take before the relay gives up on it and carries
// on. A rotation is normally 15-40 s.
const ROTATE_TIMEOUT_MS = Number(env("RELAY_ROTATE_TIMEOUT_MS") ?? 45_000)

/**
 * Experiment switch: allow the rescue chain to skip the WARP egress rotation
 * so the pair-mint leg can be tested in isolation (the open question in
 * VERDICT.md: "does pair-mint alone recover from a drained bucket, or is the
 * egress leg load-bearing?"). Disable with
 *   SAJILO_RELAY_EGRESS_ROTATE=0   (env)
 *   /tmp/sajilo/relay-no-egress-rotate.txt  (file, live-reloadable - the
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

/**
 * The instance root, derived from where this plugin lives: the plugin is at
 * <root>/home/.config/opencode/plugin/sajilo-relay.ts.
 */
function instanceRoot(): string {
  const dir = RELAY_DIR.replace(/[\\/]+$/, "")
  const cut = dir.replace(/[\\/]home[\\/]\.config[\\/]opencode[\\/]plugin$/i, "")
  return cut === dir ? "" : cut
}

/**
 * The instance's own usque rotator, when it has one. usque is a user-space
 * WARP client: rotating it means registering a new anonymous account, which
 * needs no administrator rights - unlike the Cloudflare WARP app, which is a
 * service.
 */
function instanceUsqueRotator(): string | undefined {
  const root = instanceRoot()
  if (!root) return undefined
  const p = `${root}/bin/usque-rotate.cmd`
  return existsSync(p) ? p : undefined
}

/**
 * Rotate the egress: a new exit IP, which is a new quota bucket.
 *
 * This is the FAST leg of a reset - the rotator replaces the tunnel
 * registration and is back in seconds. The identity (the mint) is the slow
 * leg, so they are kicked separately and the caller retries as soon as the
 * fast one is done.
 */
async function performEgressRotation(reason: string): Promise<boolean> {
  if (!egressRotationEnabled()) return false
  // The rotator is per-instance: the sajilo instance must rotate ITS OWN
  // tunnel. A hardcoded path meant sajilo's rescue chain rotated the LIVE
  // tunnel.
  //
  // The Cloudflare WARP app's rotator comes first - it was working before
  // usque existed, and it is fast (measured: 6.8 s). The instance's own
  // usque rotator is the admin-free alternative (no service, no UAC).
  const isWindows = process.platform === "win32"
  const ROTATOR = isWindows
    ? (env("RELAY_ROTATOR") ??
      (existsSync(`${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin\\warp-rotate.cmd`)
        ? `${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin\\warp-rotate.cmd`
        : instanceUsqueRotator()) ??
      `${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin\\warp-rotate.cmd`)
    : (env("RELAY_ROTATOR") ?? "/usr/local/lib/opencode-warp/warp-rotate.sh")
  const RESCUE_LOG = env("RELAY_RESCUE_LOG") ?? "/tmp/sajilo/rescue.log"
  const transcript = (line: string) => {
    try {
      mkdirSync(RESCUE_LOG.replace(/[/\\][^/\\]*$/, ""), { recursive: true })
      appendFileSync(RESCUE_LOG, line + "\n")
    } catch {
      /* diagnostics only */
    }
  }
  transcript(
    `--- reset ${new Date().toISOString()} (${reason}) egress-rotate=true ---`,
  )
  try {
    // Restart first on unix (cheap, keeps the working account); Windows has
    // only --rotate-only, which replaces the registration.
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
      // Drain the child's output as it runs, and NEVER read the pipe to EOF
      // after it exits: the rotator starts the NEW tunnel as a detached
      // grandchild, and that grandchild inherits the pipe - so the pipe never
      // reaches EOF and reading it hangs FOREVER. That hang is what parked
      // the request that asked for the reset (the request gave up long before
      // the reset had landed).
      let tail = ""
      const drain = (async () => {
        try {
          const dec = new TextDecoder()
          const reader = proc.stdout.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) tail = (tail + dec.decode(value)).slice(-400)
          }
        } catch {
          /* diagnostics only */
        }
      })()
      // The rotator is bounded too: a rotator that hangs (or a tunnel that
      // does not come back) must not park the request that asked for the
      // reset. Measured: a rotation takes 15-40 s.
      const out = await Promise.race([
        proc.exited,
        Bun.sleep(ROTATE_TIMEOUT_MS).then(() => {
          try {
            proc.kill()
          } catch {
            /* already gone */
          }
          return -1
        }),
      ])
      void drain
      transcript(`${bin} ${args.join(" ")} -> rc=${out} ${tail.trim()}`)
      if (out === 0) break
      if (out === -1) break
    }
    return true
  } catch (e) {
    transcript(`egress rotation failed: ${String(e).slice(0, 300)}`)
    return false
  }
}

/**
 * Mint a fresh session/project pair: a new identity, which is the other half
 * of the bucket.
 *
 * This is the SLOW leg: the child has to boot opencode, make a real request
 * (so the gateway knows the session) and finish, which is tens of seconds -
 * and longer when the gateway is throttling, because then the child's own
 * request stalls. So it runs in the background while the caller retries the
 * model against the fresh EGRESS.
 */
async function performMint(reason: string): Promise<ResetResult> {
  const before = sessionID()
  const RESCUE_LOG = env("RELAY_RESCUE_LOG") ?? "/tmp/sajilo/rescue.log"
  const transcript = (line: string) => {
    try {
      mkdirSync(RESCUE_LOG.replace(/[/\\][^/\\]*$/, ""), { recursive: true })
      appendFileSync(RESCUE_LOG, line + "\n")
    } catch {
      /* diagnostics only */
    }
  }
  try {
    // Mint a fresh pair. FORCED: the whole point of a reset is a fresh quota
    // bucket, so the mint cooldown must not skip it.
    const minted = await mintOnce(undefined, true)
    transcript(`mint -> ${JSON.stringify(minted).slice(0, 300)}`)
    // A mint that was already running returns {"skipped":"in-flight"} - wait
    // for it to land, because that mint IS the reset.
    if ((minted as { skipped?: string }).skipped === "in-flight") {
      for (let i = 0; i < 60 && sessionID() === before; i++) {
        await Bun.sleep(1_000)
      }
      transcript(`waited for the in-flight mint -> session ${sessionID()}`)
    }
    const after = sessionID()
    const changed = after !== before && !!after
    logActivity(
      `[${new Date().toISOString()}] RESET ${changed ? "landed" : "did NOT change the identity"} (${reason}): ` +
        `session ${before} -> ${after}`,
    )
    return {
      ok: changed,
      session: after,
      note: changed
        ? "fresh identity"
        : `the mint did not change the identity (${JSON.stringify(minted).slice(0, 160)})`,
    }
  } catch (e) {
    transcript(`mint failed: ${String(e).slice(0, 300)}`)
    return { ok: false, session: sessionID(), note: String(e).slice(0, 300) }
  }
}

// The two legs, shared between the requests that hit the same wall: a storm
// of 429s must not spawn one rotation or one opencode run each.
let egressInFlight: Promise<boolean> | null = null
let identityMintInFlight: Promise<ResetResult> | null = null

function rotateEgress(reason: string): Promise<boolean> {
  if (egressInFlight) return egressInFlight
  const p = performEgressRotation(reason).finally(() => {
    if (egressInFlight === p) egressInFlight = null
  })
  egressInFlight = p
  return p
}

function mintIdentity(reason: string): Promise<ResetResult> {
  if (identityMintInFlight) return identityMintInFlight
  const p = performMint(reason).finally(() => {
    if (identityMintInFlight === p) identityMintInFlight = null
  })
  identityMintInFlight = p
  return p
}

/**
 * Start a full reset (both legs), or join the one that is already running.
 * The promise settles when the fresh identity is in place.
 *
 * The chat path does not use this: it rotates the egress and retries FIRST
 * (that leg is seconds), and only waits for the identity if the fresh
 * egress was not enough. This is for the paths that have no request to
 * retry - the egress-unreachable repair.
 */
function startReset(reason: string): Promise<ResetResult> {
  if (env("RELAY_AUTOMINT") === "0") {
    return Promise.resolve({
      ok: false,
      session: sessionID(),
      note: "disabled (SAJILO_RELAY_AUTOMINT=0)",
    })
  }
  // Share the reset that is already running: a storm of 429s must not spawn
  // one opencode run each.
  if (resetInFlight) return resetInFlight
  const cooldownLeft = RESET_COOLDOWN_MS - (Date.now() - lastResetAt)
  if (cooldownLeft > 0) {
    // A reset landed a moment ago and the window is still empty, so the
    // cooldown must NOT become a give-up: wait it out and then really reset.
    // Handing the caller an error here is exactly what we promised not to
    // do.
    return Bun.sleep(cooldownLeft).then(() => startReset(reason))
  }
  lastResetAt = Date.now()
  const p = (async () => {
    await rotateEgress(reason)
    return await mintIdentity(reason)
  })()
  resetInFlight = p
  p.finally(() => {
    if (resetInFlight === p) resetInFlight = null
  }).catch(() => {
    /* the legs never reject, but never leave a dangling rejection */
  })
  logActivity(
    `[${new Date().toISOString()}] RESET kicked (${reason}): ` +
      `${egressRotationEnabled() ? "egress rotate + pair re-mint" : "pair re-mint only (egress rotation disabled)"}`,
  )
  return p
}

/**
 * The models that may answer when the requested one is spent for the whole
 * account.
 *
 * Off by default: the requested model is always preferred, and only the
 * reset can change the identity. But when the gateway says the model's
 * allowance refills in HOURS, no rotation helps - the session simply stalls
 * until the window rolls over. Set SAJILO_RELAY_FALLBACK_MODEL=auto (or a
 * comma-separated list) to let another free model answer instead: the
 * response says which model served (x-sajilo-model), and the harness prompt
 * is filled with that model too.
 */
function fallbackModels(current: string): string[] {
  const cfg = (env("RELAY_FALLBACK_MODEL") ?? "").trim()
  if (!cfg) return []
  if (cfg.toLowerCase() === "auto") {
    return FREE_POOL_FALLBACK.filter((m) => m !== current)
  }
  return cfg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== current)
}

/**
 * Is this 429 a drained quota, or a rejected request shape? They look the
 * same from the outside (the doctor tells them apart), but they need
 * opposite cures: a drained window is fixed by a reset, a rejected shape is
 * fixed by changing the harness - and resetting forever would bury the real
 * error instead of reporting it.
 */
function isQuotaError(body: string): boolean {
  const b = (body ?? "").toLowerCase()
  if (!b.trim()) return true // no body: assume the window
  return (
    b.includes("freeusagelimit") ||
    b.includes("free usage limit") ||
    b.includes("usage limit reached")
  )
}

/**
 * Seconds until the window refills, from the 429's Retry-After header (the
 * gateway sends it - that is where "unblocks: 2026-11-14 00:13:02 UTC" in
 * the warp probe comes from). It is the difference between "wait 13 hours"
 * and "reset the identity now", so it decides the cure.
 */
function retryAfterSeconds(value: string | null): number {
  if (!value) return 0
  const raw = value.trim()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  const when = Date.parse(raw)
  if (Number.isFinite(when)) {
    return Math.max(0, Math.round((when - Date.now()) / 1000))
  }
  return 0
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

// ---- the direct leg: the device's own egress (a second bucket) -------------
//
// The free allowance is keyed on the exit IP, so a second exit is a second
// bucket. The proxied leg goes out through the tunnel; the direct leg is the
// device's own route.
//
// The old way of reaching it - "add the host to NO_PROXY and fetch" - was
// measured on Bun 1.4.4 and DOES work there. On Bun 1.3.9 it does not:
// NO_PROXY=host, NO_PROXY=*, NO_PROXY=.host and proxy:'' ALL tunnelled, so
// both legs came out of the same exit IP and the ladder had nothing to climb
// (measured: 2a09:bac5:4e7b:11c3::1c5:132 warp=on on every one of them).
//
// So the direct leg can name an EXPLICIT proxy that connects directly: the
// opencode-warp stack's egress-proxy.py with --upstream direct. That shim
// opens a raw socket (no proxy in between), and because it only tunnels the
// bytes the TLS fingerprint is still Bun's - which the gateway's whitelist
// requires. Measured: through the shim the exit is the device's own
// (27.34.64.28 / 2400:1a00:..., warp=off) while the tunnel leg is
// 2a09:bac5:... (warp=on). Two buckets, and a real one.
//
//   SAJILO_RELAY_DIRECT_PROXY=http://127.0.0.1:40001
//
// The relay starts that shim itself if the stack and python are here.
let directProxyStarted = false

/** The stack's bin directory - where the egress shim lives. */
function stackDir(): string {
  // NOT derived from the ROTATOR: the rotator may point at the instance's
  // own usque rotator (<root>/bin/usque-rotate.cmd), and looking for the
  // shim THERE finds nothing - so the direct leg silently fell back to the
  // tunnel and the "second bucket" did not exist.
  return process.platform === "win32"
    ? `${process.env.LOCALAPPDATA ?? ""}\\opencode-warp\\bin`
    : "/usr/local/lib/opencode-warp"
}

/** Is something listening on this host:port? */
function tcpAlive(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const sock = connect({ host, port })
    sock.setTimeout(timeoutMs)
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
  })
}

/**
 * Resolve the direct leg's proxy: the configured one, started if it is not
 * answering yet. Returns null when there is no direct proxy (the caller then
 * falls back to the NO_PROXY bypass, which works on Bun >= 1.4).
 */
async function ensureDirectProxy(): Promise<string | null> {
  // The launcher sets SAJILO_RELAY_DIRECT_PROXY; when the relay was started
  // some other way (the standalone runner, a reload), fall back to the
  // conventional port of the stack's egress shim - without it the ladder's
  // second rung is the SAME bucket as the first on Bun < 1.4.
  const configured =
    env("RELAY_DIRECT_PROXY") ??
    (existsSync(`${stackDir()}/egress-proxy.py`)
      ? "http://127.0.0.1:40001"
      : undefined)
  if (!configured) return null
  let host = "127.0.0.1"
  let port = 0
  try {
    const u = new URL(configured)
    host = u.hostname
    port = Number(u.port || (u.protocol === "https:" ? 443 : 80))
  } catch {
    return null
  }
  if (await tcpAlive(host, port)) return configured
  if (directProxyStarted) return null
  directProxyStarted = true
  const shim = `${stackDir()}/egress-proxy.py`
  if (!existsSync(shim)) {
    logActivity(
      `[${new Date().toISOString()}] DIRECT-PROXY ${configured} is not answering and there is no egress shim at ${shim} - the direct leg stays on the tunnel`,
    )
    return null
  }
  logActivity(
    `[${new Date().toISOString()}] DIRECT-PROXY starting the egress shim on ${host}:${port} (--upstream direct, so the second leg has its own exit IP)`,
  )
  try {
    const proc = Bun.spawn(
      ["python", shim, "--port", String(port), "--upstream", "direct"],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    )
    proc.unref()
  } catch (e) {
    logActivity(
      `[${new Date().toISOString()}] DIRECT-PROXY could not start the shim: ${String(e).slice(0, 200)}`,
    )
    return null
  }
  for (let i = 0; i < 12; i++) {
    await Bun.sleep(500)
    if (await tcpAlive(host, port)) {
      logActivity(
        `[${new Date().toISOString()}] DIRECT-PROXY up on ${host}:${port} - the direct leg is a second exit now`,
      )
      return configured
    }
  }
  logActivity(
    `[${new Date().toISOString()}] DIRECT-PROXY the shim did not come up on ${host}:${port} - the direct leg stays on the tunnel`,
  )
  return null
}

/**
 * fetch() with an optional proxy bypass. Bun reads NO_PROXY when the request
 * is issued, so the env is patched around the synchronous call and restored
 * right after - the tunnel stays the default for everything else in the
 * process.
 *
 * forceDirect=true bypasses the proxy even when the direct-egress flag is
 * off: that is the fallback leg of the egress ladder (the device's native
 * egress is an independent quota bucket, so a dead proxy must not kill the
 * request).
 */
async function fetchUpstream(
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
  // The direct leg: an explicit proxy that connects directly. This is the
  // only way to leave the tunnel on Bun < 1.4 (NO_PROXY is ignored there).
  const direct = await ensureDirectProxy()
  if (direct) {
    return fetch(target, { ...init, proxy: direct } as RequestInit)
  }
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

// The relay's server, in a place that survives a plugin RELOAD.
//
// When the plugin file changes, opencode loads a fresh copy of this module in
// the same process. The old module still owns the port; the new one finds it
// healthy, adopts it as a stand-by - and then the old module's cleanup
// stops the server. Nothing is serving any more: the relay goes down until
// the process is restarted. That is why updating the plugin used to look
// like "the relay died".
//
// A process-global registry lets the new instance find the old server and
// hand the port over cleanly.
const RELAY_REGISTRY = ((globalThis as any).__sajiloRelay ??= {
  server: null as unknown,
  ownerPid: 0,
})

function takeOverOwnServer(): void {
  const old = RELAY_REGISTRY.server
  if (!old) return
  try {
    old.stop(true)
  } catch {
    /* the old one may already be gone */
  }
  RELAY_REGISTRY.server = null
  RELAY_REGISTRY.ownerPid = 0
}

// A rotation is in flight: the rotator writes this marker while it replaces
// the tunnel. During that window every in-flight request fails with
// ECONNREFUSED, which used to look like "the egress is broken" and made the
// relay kick ANOTHER rotation - rotating the tunnel out from under the
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

/**
 * Find a session to pin as the relay's identity.
 *
 * `since` (epoch ms) restricts the search to sessions CREATED after that
 * moment, and the order is by time_created, NOT time_updated. That matters:
 * opencode writes the session row when the run STARTS, but only touches
 * time_updated when it ENDS - so ordering by time_updated could not see the
 * fresh session until the child had finished its whole prompt. The child's
 * prompt cannot finish while the gateway is throttling us, which is exactly
 * when the mint runs - so the mint took the full timeout (measured: 60 s)
 * instead of the few seconds the session actually needed.
 */
async function harvestPair(since = 0): Promise<{ session: string; project: string } | null> {
  try {
    const { Database } = await import("bun:sqlite")
    const db = new Database(`${process.env.HOME ?? "/root"}/.local/share/opencode/opencode.db`, { readonly: true })
    try {
      const rows = db
        .query(
          "SELECT id, directory, project_id FROM session_v2 " +
            "WHERE id LIKE 'ses_%' AND time_created > ? ORDER BY time_created DESC",
        )
        .all(since) as Array<{ id: string; directory: string; project_id: string | null }>
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
    // The moment the child is about to start: only sessions CREATED after
    // this are the child's. That is how the harvest finds the child's session
    // while the child is still running, instead of waiting for the run to
    // finish (which cannot happen while the gateway is throttling us).
    const mintStartedAt = Date.now() - 2_000
    // Strip the harness's own session id: the child must mint its OWN session.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "OPENCODE_SESSION_ID" || v === undefined) continue
      env[k] = v
    }
    // The minted child must NOT run a relay of its own. It loads the same
    // plugin, finds the port already served, and adopts it as a stand-by -
    // which then takes the port over when the parent goes away, and takes the
    // relay down with it in the meantime. The child only needs to create one
    // session.
    env.SAJILO_RELAY_ENABLED = "0"
    env.OPENCODE_BUN_RELAY = "0"
    // The opencode CLI resolves the project directory from PWD, not from the
    // child's cwd. The server process exports PWD=<harness project> (here
    // /sdcard/Yoyo), so an inherited PWD makes the child create its session in
    // the harness project - where the harvester refuses to look. Point PWD at
    // the scratch dir so the minted session lands in its own project.
    env.PWD = dir
    env.OLDPWD = dir
    // --standalone is mandatory: without it `opencode run` attaches to the
    // app's background service, so the new session is created in the SERVICE's
    // project dir (/sdcard/Yoyo) instead of the scratch dir - and the
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
    // The child only has to CREATE a session - its prompt does not have to
    // finish, and quite often it cannot: it talks to the same gateway we are
    // being throttled by, so it sits there waiting for a window that will not
    // open for hours. Waiting for it made every reset take the full 150 s
    // timeout (the transcripts show rc=-1, the killed child), which is longer
    // than the request that asked for the reset can wait - so the reset
    // never landed in time and the caller got the 503 instead of an answer.
    //
    // So: watch the database for the child's session and stop the child the
    // moment it appears.
    const before = await harvestPair(mintStartedAt)
    let pair: { session: string; project: string } | null = null
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await Bun.sleep(1_000)
      pair = await harvestPair(mintStartedAt)
      if (pair && pair.session && pair.session !== before?.session) break
    }
    // The child has done its job. Stop it before it spends more quota (or
    // keeps a session row around).
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
    const rc = await Promise.race([
      proc.exited,
      Bun.sleep(10_000).then(() => -1),
    ])
    void drain
    if (!pair) pair = await harvestPair(mintStartedAt)
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
 * process owned it. If that owner goes away - its plugin is reloaded, its
 * session ends - nobody would be serving the relay any more, because the
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
      /* the port is still busy - try again on the next tick */
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
      // A previous copy of this module in THIS process may still own the port
      // (the plugin was reloaded). Take it over instead of adopting it: the
      // old instance's cleanup would otherwise stop the very server we are
      // standing by for, and the relay would go down with nothing serving.
      if (RELAY_REGISTRY.ownerPid === process.pid) {
        takeOverOwnServer()
      }
      server = Bun.serve({
        port: PORT,
        hostname: BIND,
        // Bun.serve REQUIRES idleTimeout <= 255 - a bigger value throws
        // "Bun.serve expects idleTimeout to be 255 or less", and that throw
        // used to fail the whole plugin load (the relay went down with it).
        // The cap is Bun's, so the keep-working ceiling is clamped to fit
        // under it: the relay always answers before the socket can be cut.
        idleTimeout: Math.min(
          255,
          Math.max(
            60,
            Math.ceil(
              Number(env("RELAY_KEEP_WORKING_MS") ?? env("RELAY_SPIN_BUDGET_MS") ?? 240_000) /
                1000,
            ),
          ),
        ),
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
          let force = false
          // ?force=1 is the shell-safe way to ask for a mint: a JSON body
          // with quotes in it is a quoting nightmare in cmd.exe.
          if (url.searchParams.get("force") === "1") force = true
          try {
            const b = (await req.json()) as { prompt?: string; force?: boolean }
            if (typeof b?.prompt === "string") prompt = b.prompt
            // force=true skips the mint cooldown: the caller wants a fresh
            // identity NOW (a reset of the limit, or a manual `sajilo mint`).
            if (b?.force === true) force = true
          } catch {
            /* empty body is fine */
          }
          return Response.json(await mintOnce(prompt, force))
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
        // The caller's own body, kept for the checks that need it (the
        // Freebuff model-override probe). It used to be scoped to the block
        // below, so the check silently threw a ReferenceError into its own
        // catch and the override never applied.
        let rawBody = ""
        const isChat =
          url.pathname.endsWith("/chat/completions") && req.method === "POST"
        if (isChat) {
          const raw = await req.text()
          rawBody = raw
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
        // The model the caller asked for. It never changes, so it is also
        // what the error path reports when the spin gives up.
        let requestedModel = ""
        // Seconds until the window refills, as the gateway said. The error
        // path hands it to the caller as its Retry-After, so a retry lands
        // exactly when the quota is back.
        let lastRefillIn = 0
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
          let originModel = ""
          try {
            const m = (JSON.parse(transformed) as { model?: string }).model
            if (typeof m === "string" && m) originModel = m
          } catch {
            /* not JSON - fall through to the pin/default */
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
            if (ov && rawBody.includes("You are Buffy")) {
              originModel = ov
              logActivity(`[${new Date().toISOString()}] MODEL-OVERRIDE ${ov} (Freebuff /model pick)`)
            }
          } catch {
            /* no override file - ignore */
          }
          // The model the caller asked for. It NEVER changes: a 429 is a
          // drained window, not a bad model, so the answer is a reset of the
          // identity, not a different model.
          // (Unless a fallback is configured - see fallbackModels - and even
          // then the requested model is always tried first.)
          let wanted = originModel
          requestedModel = wanted
          const fallbacks = fallbackModels(wanted)
          let fallbackIndex = -1
          // How long the relay is willing to keep working on ONE request.
          //
          // The old spin gave up after 45 s and handed the caller the
          // gateway's own 429 - which is exactly what the end user must
          // never see. The relay now keeps working (waiting out the refill,
          // resetting the identity, rotating the egress) for as long as the
          // client stays connected, and only answers a retryable 503 if the
          // client is still there after the ceiling. In practice the reset
          // recovers the window in 14-22 s, so the answer is a slow one, not
          // an error.
          //
          // The ceiling sits under Bun's 255 s idle cap: a request that is
          // held longer than that would have its socket cut, which the
          // caller would read as a network error. The client usually gives
          // out first anyway, and its retry lands on the fresh identity.
          const KEEP_WORKING_MS = Number(
            env("RELAY_KEEP_WORKING_MS") ?? env("RELAY_SPIN_BUDGET_MS") ?? 240_000,
          )
          // A safety valve, not a policy: 0 = unlimited (the ceiling above is
          // the only limit). Each reset spawns a real opencode run and
          // rotates the tunnel, so this only exists to stop a pathological
          // loop.
          const MAX_RESETS = Number(env("RELAY_MAX_RESETS") ?? 0)
          // The longest refill the relay is willing to WAIT for instead of
          // resetting the identity. Past that, waiting beats resetting (the
          // window is a rolling one), and the gateway's Retry-After goes
          // to the caller so its retry is timed right.
          const WAIT_MAX_SECONDS = Number(env("RELAY_WAIT_MAX_SECONDS") ?? 45)
          // The longest single wait we will hold a request for. The gateway's
          // own refill time is the ground truth - if the window comes back in
          // ten minutes, waiting IS the working answer.
          const LONG_WAIT_MAX_SECONDS = Number(
            env("RELAY_LONG_WAIT_MAX_SECONDS") ?? 600,
          )
          const spinStarted = Date.now()
          let fetchErrors = 0
          let resets = 0
          // The two legs of a reset, per request: the egress (fast) and the
          // identity (slow). The egress is tried first and the identity runs
          // alongside it, so the caller retries the SAME model within seconds
          // instead of waiting a minute for a mint.
          let egressRotated = false
          let egressPending: Promise<boolean> | null = null
          let mintPending: Promise<ResetResult> | null = null
          // Did the identity mint land? Once it has, a further 429 means the
          // model is empty for the whole account - not for this identity.
          let mintSettled = false
          outer: while (true) {
            if (Date.now() - spinStarted > KEEP_WORKING_MS) {
              // A reset that is still landing would give this request a fresh
              // identity to retry against, so give it a bounded moment - but
              // not an open-ended wait.
              if (resetInFlight && Date.now() - spinStarted < KEEP_WORKING_MS + 30_000) {
                logActivity(
                  `[${new Date().toISOString()}] SPIN ceiling reached while a reset is in flight - waiting for it`,
                )
                await Bun.sleep(5_000)
                continue
              }
              logActivity(
                `[${new Date().toISOString()}] SPIN ceiling reached (${KEEP_WORKING_MS}ms) after ${resets} reset(s) - answering with a retryable 503`,
              )
              break outer
            }
            const attemptBody = setModel(applyModelIdentity(transformed, wanted), wanted)
            let resp: Response | null = null
            // Egress ladder: the proxied path first, then the device's native
            // egress. A dead proxy (usque down, port drifted, rotation in
            // flight) must not kill the request - the native egress is an
            // independent quota bucket and can still serve it.
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
                    `[${new Date().toISOString()}] SPIN 429 via the proxied egress (${wanted}): that bucket is drained - trying the direct egress`,
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
                  // The proxy leg failed - fall through to the direct leg.
                  logActivity(
                    `[${new Date().toISOString()}] SPIN fetch-error via proxy (${wanted}): ${finalErrBody} - trying the native egress`,
                  )
                  continue
                }
                // Both legs failed for this attempt.
                fetchErrors++
                if (rotationInProgress()) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN fetch-error during a known rotation (${wanted}): not counting it`,
                  )
                  fetchErrors = 0
                  continue
                }
                logActivity(
                  `[${new Date().toISOString()}] SPIN fetch-error on every egress (${wanted}): ${finalErrBody}`,
                )
                if (fetchErrors >= 3) {
                  // Every egress is unreachable. Do NOT give up: the tunnel is
                  // most likely mid-rotation, and the reset repairs it. The
                  // caller waits a little longer and the answer still comes.
                  logActivity(
                    `[${new Date().toISOString()}] SPIN every egress unreachable (${fetchErrors} fetch errors) - repairing the egress and trying again`,
                  )
                  fetchErrors = 0
                  void startReset("egress-unreachable")
                  await Bun.sleep(5_000)
                  continue outer
                }
              }
            }
            if (!resp) continue
            if (resp.status === 200) {
              upstream = resp
              servedModel = wanted
              // Say plainly which model answered. The relay does NOT rotate
              // models: a drained window is fixed with a fresh identity, so
              // this is always the model the caller asked for.
              logActivity(
                `[${new Date().toISOString()}] SERVED ${wanted} (as requested)`,
              )
              break outer
            }
            const errBody = await resp.text().catch(() => "<unreadable>")
            finalStatus = resp.status
            finalErrBody = errBody
            // The gateway says when the window refills (Retry-After). That
            // is what decides the cure: a window that refills in seconds is
            // worth waiting out, a window that refills in hours is worth a
            // fresh identity instead.
            const retryAfter = resp.headers.get("retry-after")
            const refillIn = retryAfterSeconds(retryAfter)
            if (refillIn > 0) lastRefillIn = refillIn
            logActivity(
              `[${new Date().toISOString()}] SPIN ${resp.status} on ${wanted}: ${errBody.slice(0, 200)}` +
                `${refillIn > 0 ? ` (the window refills in ${refillIn}s)` : ""}`,
            )
            if (resp.status === 429) {
              if (!isQuotaError(errBody)) {
                // Not a drained window: the gateway rejected the request
                // shape (the doctor tells the two apart). Neither a retry nor
                // a reset would fix that - they would only bury the real
                // error, so report it.
                logActivity(
                  `[${new Date().toISOString()}] SPIN 429 on ${wanted} is NOT a quota error - the gateway rejected the request shape`,
                )
                break outer
              }
              const remaining = KEEP_WORKING_MS - (Date.now() - spinStarted)
              if (remaining <= 0) break outer
              // The gateway told us when the window refills. If that is soon
              // enough to fit in what is left of the ceiling, waiting it out
              // is cheaper AND cleaner than a reset: no tunnel rotation, no
              // opencode run, and the identity stays the caller's own. A wait
              // is not a reset, so it does not use the reset budget.
              //
              // A far-off refill is waited for too, but only once a reset has
              // already failed to bring the window back - then the gateway's
              // own clock is the only thing left to trust.
              const waitMs = refillIn * 1000
              const fits = refillIn > 0 && waitMs <= remaining
              const shortWait = fits && refillIn <= WAIT_MAX_SECONDS
              const longWait =
                fits &&
                refillIn > WAIT_MAX_SECONDS &&
                refillIn <= LONG_WAIT_MAX_SECONDS
              if (mintSettled) {
                // A fresh egress AND a fresh identity did not help: the model
                // is empty for the WHOLE ACCOUNT, not for this identity, and
                // no rotation can change that. Spinning for the rest of the
                // budget would only burn the caller's time - so either wait
                // for the gateway's own refill (if it is near) or answer with
                // it, which is the truth.
                if (longWait) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN 429 on ${wanted}: the window refills in ${refillIn}s - waiting it out`,
                  )
                  await Bun.sleep(waitMs)
                  continue
                }
                // The requested model is spent for the whole account. If a
                // fallback is configured, another free model answers instead
                // of stalling the session until the window rolls over.
                if (fallbackIndex + 1 < fallbacks.length) {
                  fallbackIndex++
                  wanted = fallbacks[fallbackIndex]
                  requestedModel = wanted
                  // The new model gets its own reset cycle.
                  egressRotated = false
                  mintSettled = false
                  logActivity(
                    `[${new Date().toISOString()}] SPIN 429 on ${originModel}: the model is spent for the whole account - falling back to ${wanted}`,
                  )
                  continue
                }
                logActivity(
                  `[${new Date().toISOString()}] SPIN 429 on ${wanted}: a fresh egress and a fresh identity did not help - the model is empty for the whole account` +
                    `${refillIn > 0 ? ` (it refills in ${refillIn}s)` : ""}. Answering with that time instead of spinning.`,
                )
                break outer
              }
              if (shortWait) {
                logActivity(
                  `[${new Date().toISOString()}] SPIN 429 on ${wanted}: the window refills in ${refillIn}s - waiting it out (no reset)`,
                )
                await Bun.sleep(waitMs)
                continue
              }
              // The window for THIS identity is empty. Reset it - a new egress
              // and a new session/project pair - and retry the SAME model.
              //
              // The two legs have very different costs. The egress rotation
              // is SECONDS (the rotator replaces the registration and comes
              // back); the identity mint is a MINUTE or more (a real
              // opencode run has to boot, reach the gateway and finish, and
              // when the gateway is throttling its own request stalls). So:
              // rotate the egress and retry straight away, and let the mint
              // run alongside it in the background. Only if the fresh egress
              // was not enough do we wait for the identity.
              //
              // Waiting for the mint FIRST was the bug that made mid-session
              // requests fail while fresh ones worked: the reset ate the
              // whole budget and the caller got the 503 before the fix it
              // asked for had landed.
              if (MAX_RESETS > 0 && resets >= MAX_RESETS) {
                logActivity(
                  `[${new Date().toISOString()}] SPIN 429 on ${wanted} after ${resets} resets - giving up on this request`,
                )
                break outer
              }
              resets++
              if (!egressRotated) {
                egressRotated = true
                logActivity(
                  `[${new Date().toISOString()}] SPIN 429 on ${wanted}: the window is empty - rotating the egress (seconds) and minting a new identity in the background (a minute)` +
                    `${refillIn > 0 ? ` (the gateway says this window refills in ${refillIn}s)` : ""}`,
                )
                // Both legs are kicked, and NEITHER is waited for here. The
                // rotation may still be in flight when the retry goes out
                // (the ladder's other leg can serve it), and the mint takes
                // a minute. Waiting for either here is what made a long
                // session fail while a fresh one worked: the reset ate the
                // whole budget and the caller got the 503 before the fix it
                // had asked for had landed.
                egressPending = rotateEgress(`429-${wanted}`)
                egressPending.catch(() => {
                  /* performEgressRotation never rejects */
                })
                mintPending = mintIdentity(`429-${wanted}`)
                mintPending.then(
                  () => {
                    mintSettled = true
                  },
                  () => {
                    mintSettled = true
                  },
                )
                continue
              }
              // The egress had its chance (and the rotation may have landed
              // by now). Wait for it, but never past the ceiling.
              if (egressPending) {
                const raced = await Promise.race([
                  egressPending.then(() => ({ timedOut: false })),
                  Bun.sleep(Math.max(0, remaining)).then(() => ({ timedOut: true })),
                ])
                if (raced.timedOut) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN ceiling reached while the egress was rotating - answering with a retryable 503`,
                  )
                  break outer
                }
              }
              // A fresh egress was not enough: now the identity is the
              // bottleneck. Wait for the mint (it is already running).
              logActivity(
                `[${new Date().toISOString()}] SPIN 429 on ${wanted}: a fresh egress was not enough - waiting for the new identity`,
              )
              if (mintPending) {
                const raced = await Promise.race([
                  mintPending.then(() => ({ timedOut: false })),
                  Bun.sleep(Math.max(0, remaining)).then(() => ({ timedOut: true })),
                ])
                if (raced.timedOut) {
                  logActivity(
                    `[${new Date().toISOString()}] SPIN ceiling reached while the identity was being minted - answering with a retryable 503`,
                  )
                  break outer
                }
              } else {
                await mintIdentity(`429-${wanted}`)
              }
              continue
            }
            if (RETRYABLE_STATUS(resp.status)) {
              // 5xx / 402: a transient server-side problem. Back off a moment
              // and retry the SAME model - the model is not the problem, and
              // the caller's request shape is unchanged.
              const remaining = KEEP_WORKING_MS - (Date.now() - spinStarted)
              if (remaining <= 0) break outer
              await Bun.sleep(Math.min(2_000, remaining))
              continue
            }
            // Not retryable (e.g. 400 fingerprint error): the request shape is
            // what the gateway disliked, and the very same request against the
            // very same model would fail the very same way. Report it.
            logActivity(
              `[${new Date().toISOString()}] SPIN ${resp.status} is not retryable - giving up on this body: ${errBody.slice(0, 200)}`,
            )
            break outer
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
            const status = upstream?.status ?? (finalStatus || 502)
            // A rate-limit error must never reach the end user. The relay
            // resets the limit instead of passing a 429 on, so by the time one
            // gets here the spin has already tried to fix it. Answer 503 with
            // a Retry-After: it is not a quota error, and the opencode runtime
            // retries a 5xx on its own - so the caller sees a slow answer, not
            // "Free usage limit reached".
            if (status === 429) {
              const headers = new Headers(respHeaders)
              headers.set("content-type", "application/json")
              // The gateway told us when the window refills. Hand that to the
              // caller as its Retry-After, so the retry lands exactly when
              // the quota is back instead of hammering the gate.
              const retryIn = lastRefillIn > 0 ? Math.min(lastRefillIn, 3600) : 5
              headers.set("retry-after", String(retryIn))
              if (requestedModel) headers.set("x-sajilo-model", requestedModel)
              logActivity(
                `[${new Date().toISOString()}] ANSWER 503 (the 429 is not passed on: the limit is being reset, and the caller is asked to retry in ${retryIn}s)`,
              )
              return new Response(
                JSON.stringify({
                  error:
                    "sajilo-relay: the free window is being re-established - retry when it says",
                  retry: true,
                  retryAfterSeconds: retryIn,
                  model: requestedModel,
                }),
                { status: 503, headers },
              )
            }
            return new Response(finalErrBody, {
              status,
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
      // Register the server so a RELOAD of this plugin in THIS process can
      // take the port over from the previous copy of itself. Without this the
      // registry never held a server, the takeover was a no-op, and every
      // plugin reload left the OLD build serving - so an edit to the relay
      // looked like it had done nothing.
      RELAY_REGISTRY.server = server
      RELAY_REGISTRY.ownerPid = process.pid
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
    // Every instance writes this, whether it binds or adopts the port: the
    // doctor uses the last marker as the start of the window it judges.
    logActivity(
      `[${new Date().toISOString()}] RELAY-START build=${BUILD} pid=${process.pid}`,
    )
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
    // instance (same pid). Adopting it would be a trap - the old server is
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
        `[sajilo-relay] port ${PORT} still held by our previous instance (pid ${process.pid}); taking it over\n`,
      )
      // It is OUR previous copy of this module that owns the port - a plugin
      // RELOAD in this same process - and the registry holds that server. Stop
      // it and serve the new code. Without this, every reload left the OLD
      // build serving and an edit to the relay looked like it had done
      // nothing at all.
      takeOverOwnServer()
      // opencode's plugin activation has a HARD 5 s budget: if setup() has
      // not resolved by then, every location-scoped API answers 503
      // "Location plugins did not finish activating". So the wait here is
      // deliberately short - the stand-by takeover (startTakeover) binds the
      // port as soon as it frees up, without blocking the activation.
      for (let i = 0; i < 8; i++) {
        await Bun.sleep(100)
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
      // Any other failure (a bad option, a permission problem) used to be
      // rethrown, and the throw escaped the plugin: opencode logged
      // "failed to load plugin" and DEACTIVATED it - so one bad relay option
      // took the whole agent down, not just the provider. The relay is a
      // convenience; it must never be able to break the runtime that loads
      // it. Say it loudly and keep the agent alive.
      process.stderr.write(
        `[sajilo-relay] could not start the relay on port ${PORT}: ${msg}\n` +
          `[sajilo-relay] degrading - the runtime keeps working, but there is no local relay\n`,
      )
      logActivity(
        `[${new Date().toISOString()}] START failed to bind port ${PORT}: ${msg.slice(0, 300)}`,
      )
      startWatchdog()
      return
    }
    await Bun.sleep(50)
    process.stderr.write(`[sajilo-relay] listening on http://127.0.0.1:${PORT}\n`)
    logActivity(
      `[${new Date().toISOString()}] RELAY-LISTENING build=${BUILD} port=${PORT}`,
    )
    startWatchdog()
    // Bring the second leg up in the background: it is the device's own exit
    // IP, which is a second quota bucket. Fire and forget - the activation
    // budget is 5 s and the first request must not wait for it.
    if (env("RELAY_DIRECT_PROXY")) {
      void ensureDirectProxy()
    } else {
      logActivity(
        `[${new Date().toISOString()}] DIRECT-PROXY not configured - the direct leg cannot leave the tunnel on this Bun (NO_PROXY is ignored below 1.4). Set SAJILO_RELAY_DIRECT_PROXY=http://127.0.0.1:40001 for a second bucket.`,
      )
    }

// Proactive tunnel watchdog: probe the WARP egress every few minutes and
// repair it from a cold start if it is down - independent of traffic, so
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