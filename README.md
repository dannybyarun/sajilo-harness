# Sajilo (सजिलो)

**A coding agent harness of its own.** *Sajilo* means *easy* - a harness that
is easy to install, easy to point at your work, and easy to keep away from the
agent you are already talking to.

Sajilo owns its **harness spec** - the system prompt, the 12-tool set, the
voice, the identity - and runs it inside a completely isolated instance: its
own database, its own sessions, its own project directory, its own relay, its
own tunnel, its own pins.

```
  sajilo
    ├─ harness spec   plugin/resources/agent-prompt.txt   (identity + rules)
    │                 plugin/resources/agent-tools.json   (the 12 tools)
    ├─ provider layer plugin/sajilo-relay.ts             (the relay)
    └─ runtime        opencode, isolated by its own HOME
```

Anything you do in it - rotate the egress, kill the tunnel, drain the quota,
break the plugin - cannot disconnect the opencode you are already using.

## Why it is also the resilient one

Sajilo's runtime talks to the gateway through the Sajilo relay, so it inherits
everything the relay knows how to do:

- the **gateway whitelist** (the relay rewrites the body into the approved
  "agent class" - the free models only accept that shape),
- the free-model **pool rotation** (ten free models, the relay rotates when
  one is drained),
- the **egress ladder** (proxied path first, then the device's native
  egress - a dead proxy no longer kills the request),
- the **spin budget** (a request is never parked for minutes),
- the **rescue chain** (rotate the egress and refresh the credential in the
  background).

## Install

### Windows - one click

Download this repo and **double-click `install.cmd`**.

That is the whole install. It creates the instance, wires the launcher into
your PATH, drops a shortcut on your desktop and opens Sajilo. No
administrator rights, nothing to type, nothing to configure.

If you prefer a terminal:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### Linux / macOS - one command

```bash
curl -fsSL https://raw.githubusercontent.com/dannybyarun/sajilo-harness/main/install.sh | bash
```

Or from a clone:

```bash
git clone https://github.com/dannybyarun/sajilo-harness.git
cd sajilo
bash install.sh
```

### What the installer does for you

| step | detail |
|---|---|
| instance layout | `~/.sajilo` (`%USERPROFILE%\.sajilo`): own HOME, DB, sessions, project, relay port, pins, logs |
| harness spec | the relay plugin and the prompt/tool resources, from the clone or downloaded from the repo |
| launcher | `sajilo` on your PATH, plus a desktop shortcut (Windows) or launcher (Linux) |
| runtime | your existing opencode is used and pinned; if the machine has none, the standalone build is downloaded into the instance |
| tunnel | `usque`/WARP is used where it exists, otherwise the native egress |

Nothing is overwritten in your existing opencode: Sajilo keeps its own HOME,
its own database and its own ports.

Then:

```bash
sajilo              # interactive
sajilo run "hi"     # headless
sajilo status       # what is running
```

### Wherever you are

Sajilo opens in **the directory you are standing in** - not in some private
folder - so it works on the project you are actually looking at:
```bash
cd ~/projects/my-app
sajilo                            # the TUI, in my-app
sajilo ../other-repo              # or in the directory you name
sajilo run "fix the failing test" # one prompt, right here
```

The isolation never depended on the directory: it comes from the HOME. The
instance keeps its own database, its own sessions, its own config, its own
relay and its own ports, whatever you point it at. The project directory only
decides *what you are working on*.

One caveat worth knowing: opencode reads a project-level `opencode.json` next
to the code you open, and that file wins over the instance config for the
keys it sets. If a project pins a model, sajilo follows it (the relay follows
whatever the harness asks for). If a project redirects the provider's
`baseURL`, that redirect wins too - delete it, or use `sajilo direct` there.

## The harness spec

`plugin/resources/agent-prompt.txt` is Sajilo's system prompt and
`plugin/resources/agent-tools.json` is its tool set. Both are yours to edit -
reinstalling does not overwrite them, and the relay re-reads them when it
starts.

Two rules in the prompt are worth knowing about:

- **It knows what it is.** The `Your Model` block is filled in with the model
  that actually served the request, so the agent never claims to be a model it
  is not. The free pool rotates underneath it.
- **It answers in your language.** Write in Nepali, get Nepili back. The
  harness spec itself stays English - the gateway's whitelist is matched on
  the shape of the request, not on its prose.

## Choosing the model

One place, one file, both sides.

```bash
sajilo model                  # what is it right now?
sajilo model glm-5.3-flash-free   # pin it
sajilo model --auto           # back to the free pool
```

`sajilo model <name>` writes a single pin file (`<root>/state/model.txt`).
**Both** sides read it, live:

- the launcher puts it in the runtime config, so the harness shows and uses
  that model,
- the relay re-reads it on **every request**, so the model that goes upstream
  changes immediately - no restart, no second file to edit.

The default is **DeepSeek V4.1 Flash Free** - the harness starts on it and the
relay leads with it, so the two always agree.

The pin is a preference, not a straitjacket: if the pinned model is drained,
the relay still falls back to the free pool and keeps the request alive. With
no pin, the relay rotates the pool on its own.

### Switching the model in the TUI just works

The relay follows whatever the harness asks for. Pick a model with `/model` in
the TUI and the next request upstream uses it:

```
[2026-11-12T07:42:16.065Z] MODEL glm-5.3-flash-free (chosen by the harness)
```

The harness owns the model; the relay is just the transport.

The harness prompt's `Your Model` block is filled in with the model that
actually served the request, so the agent knows what it is:

```
> in one line: your name and the exact model id you are running as?
Sajilo, running as `sajilo/glm-5.3-flash-free`.
```

## The interface

Sajilo brings its own identity to the terminal, not just to the prompt:

| where | what it says |
|---|---|
| next to the model | `Build · DeepSeek V4.1 Flash Free **Sajilo**` |
| the terminal tab | the working directory - not "OpenCode" |
| the model picker | only the free pool the relay can actually serve |
| the prompt | "You are Sajilo, a coding agent harness" |

The provider in the runtime config is Sajilo's own (`sajilo`, named "Sajilo"),
not the built-in `opencode` one - which is what the TUI prints next to the
model. The CLI settings are injected inline, so the terminal title stops
saying "OpenCode" and the update dialog stays out of the way.

### `sajilo rebrand`

The identity is applied automatically, but you can drive it by hand:

```bash
sajilo rebrand            # apply the Sajilo identity
sajilo rebrand --status   # what is branded right now
sajilo rebrand --restore  # back to the stock opencode identity
```

```
rebrand: identity -> Sajilo
  provider name      : Sajilo
  terminal title     : off (no OpenCode in the tab)
  update dialog      : off
  splash banner      : off
  welcome wordmark   : the runtime's own art - not replaceable
```

One piece stays: the runtime's welcome art - the big word drawn on the start
screen. It is a compressed asset inside the opencode binary, and no supported
setting replaces it. Patching it would mean a private copy of the runtime
(a ~250 MB binary the instance owns) plus surgery on the compressed asset,
and it would be lost on every opencode update - so it is not done behind your
back.

## Use it from other agents

The relay is a plain **OpenAI-compatible endpoint**. Any client that speaks
OpenAI can use Sajilo as a custom provider - and it gets the whole relay
behaviour: the gateway whitelist, the free-model pool rotation, the egress
ladder, the spin budget, the rescue chain.

```bash
sajilo relay      # start the provider on its own (headless)
```

```
sajilo relay listening on http://127.0.0.1:43914
  models    : http://127.0.0.1:43914/v1/models
  base url  : http://127.0.0.1:43914/v1
```

Then point your agent at it:

```bash
# any OpenAI SDK
export OPENAI_BASE_URL=http://127.0.0.1:43914/v1
export OPENAI_API_KEY=anything          # the key is ignored
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:43914/v1", api_key="anything")
client.chat.completions.create(
    model="deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "hello"}],
)
```

```bash
# curl
curl http://127.0.0.1:43914/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

What is verified working through that endpoint:

| call | result |
|---|---|
| `GET /v1/models` | the 11 free models - only those, because the paid ones just 429 |
| `POST /v1/chat/completions` | `200` with a normal JSON completion |
| the same with `"stream": true` | `text/event-stream`, `chat.completion.chunk` frames, `data: [DONE]` |
| the same with `"tools": [...]` | real `tool_calls` back, arguments included |
| `Authorization: Bearer <anything>` | accepted - the key is ignored |

Both paths work: `/v1/...` (what every SDK appends to a base URL) and
`/openai/v1/...`.

### Two ways to be a provider

```bash
sajilo relay            # the other agent gets SAJILO's brain (harness + tools)
sajilo relay --lean     # the other agent keeps ITS OWN brain, 40% lighter
```

The default makes Sajilo the harness: your agent's requests are rewritten
into Sajilo's agent class (its prompt, its 12-tool set) with the caller's own
tools appended - the tools still work, the voice is Sajilo's.

`--lean` is the other way round: the caller's own system prompt and toolset
go upstream untouched, and none of Sajilo's footprint is added. Measured on a
real third-party agent, that is a **48 KB request down to 30 KB** - and the
free allowance is weight-based, so a lighter request is a request that still
fits when the window is nearly empty.

Which one to use:

- you want the other agent to behave like Sajilo -> default
- you want the other agent to behave like *itself* -> `--lean`

### The free tier is the real limit

The gateway's free allowance is a rolling window, and it is **weighted by the
request**: a small request fits when a big one does not. A third-party agent
with a full toolset (19 tool schemas, tens of KB of prompt) can exhaust the
window that a one-tool agent uses comfortably. When it is empty, the relay
tries all eleven free models and answers with the real 429 - the caller sees
the gateway's own error, in the gateway's own words.

### From another machine

The relay listens on `127.0.0.1` by default, so it serves this machine (every
local agent). To serve the network:
```bash
SAJILO_RELAY_BIND=0.0.0.0 SAJILO_RELAY_TOKEN=$(openssl rand -hex 16) sajilo relay
```

A token is **required** for anything but loopback - the relay spends the
account's free quota, and the relay refuses to bind without one.

### What does not work

Clients that speak the **Anthropic** shape (`/v1/messages`) need a translator
in front: the relay is OpenAI-shaped only. Point them at the OpenAI endpoint
through a converter, or use an agent that speaks OpenAI.

## Checking it is healthy

```bash
sajilo doctor
```

```
instance
  ok    home
  ok    state
  ok    relay plugin
  ok    harness prompt
  ok    harness tools

harness spec
  ok    sections intact (4/4)
  ok    model block is a template (filled per request)
  ok    identity: Sajilo
  ok    12 tools in the spec

runtime
  ok    runtime: C:\Users\Arun\AppData\Roaming\npm\opencode.cmd

relay
  ok    listening on http://127.0.0.1:43914 (pid 19568, 0 requests served)
  ok    mode: harness=sajilo tools=sajilo auth=open

gateway
  ok    harness accepted by the gateway (1.3s)
  ok    model replied: SAJILO OK

identity
  ok    provider: sajilo
  ok    model: sajilo/deepseek-v4.1-flash-free

all checks passed
```

The gateway probe matters most. The harness spec is a **contract with the
gateway**: the system prompt has to keep the agent-class shape and the
twelve-tool set has to be there. Break either and every request comes back
`429` - which looks exactly like an empty quota window, so it is easy to
misdiagnose. The doctor sends the instance's real harness upstream and tells
you which of the two it is.

## The harness spec is yours

`plugin/resources/agent-prompt.txt` and `agent-tools.json` are copied into
the instance on install - and then **never overwritten**. Reinstalling keeps
your version and puts the new one next to it as `*.bak`, because a clobbered
spec can silently break the harness.

What you can change freely: the identity, the voice, the rules, the language
policy, the model block. What you should not: the *shape* - the sections the
gateway recognises (Harness, Communication, Working in codebases, Your Model)
and the twelve tool names. `sajilo doctor` checks both.

## The harness learns itself

The harness spec is a contract with the gateway: the system prompt has to keep
the agent-class shape and the twelve tool names have to be there. Break either
and every request comes back `429` - which looks exactly like an empty quota
window.

So Sajilo does not keep a frozen copy. **Every request the runtime makes
carries its own live prompt and its own live tools** - MCP servers included -
and the relay captures them. An opencode update therefore flows through by
itself: the next request teaches the relay the new harness, and Sajilo's
identity and rules are layered on top.

```
live harness
  ok    captured from the runtime (22445 chars, 12 tools, 52s ago)
  ok    overlay: identity present
  ok    overlay: rules present
```

What actually goes upstream is the runtime's own prompt, with Sajilo's layer
on it:

```
# Harness | # Communication | # Working in codebases | # Your Model | # Code Mode | # Sajilo
```

- the **first line** is replaced by Sajilo's identity,
- the **model block** is Sajilo's template, filled in per request with the
  model that actually served it (the relay rotates models under the hood, and
  the agent reports the truth - `Sajilo, nemotron-3.5-lightning-free`),
- a **`# Sajilo` section** carries Sajilo's own rules.

Everything else - the sections, the tool catalog, the MCP tools - is whatever
the runtime says it is.

`plugin/resources/sajilo-overlay.md` is that layer, and it is yours: the
`# Identity` block is the sentence that replaces the first line, and the
`# Rules` block becomes the `# Sajilo` section. Edit it, and the next request
uses it. (The gateway accepts both - measured, not assumed.)

## MCP and other plugins

They come for free with the capture. A tool the runtime registers - an MCP
server, a plugin, a skill - arrives in the request, the relay passes it
through, and the catalog in the prompt lists it. Nothing to configure.

One rule the relay adds for third-party agents: if the caller supplied its
own tools, the model is told to use only those. The harness toolset is still
in the request (the gateway expects it), but a call the caller cannot execute
breaks the turn.

## Platform matrix

| | Linux / macOS / WSL | Windows |
|---|---|---|
| separate HOME, DB, sessions, project | yes | yes |
| own relay (port 43914) with pool/ladder/budget/rescue | yes | yes |
| own **rotatable** WARP tunnel (usque) | yes (if `usque` is present) | no - native egress |
| egress recovery by rotating the IP | yes | native egress only (a second bucket can be added by pointing `SAJILO_RELAY_PROXY` at any local HTTP proxy) |
| the live opencode is unaffected | yes | yes |

Where `usque` is not available the relay simply uses the machine's native
egress - still a completely separate instance, it just has no *rotatable*
second bucket. To give it one, point it at any local HTTP proxy:

```bash
SAJILO_TUNNEL_PORT=8080 SAJILO_RELAY_PROXY=http://127.0.0.1:8080 sajilo
```

## Layout

```
<root>/                     default ~/.sajilo   (%USERPROFILE%\.sajilo)
  home/                     HOME for the runtime - own DB, config, plugins
  work/                     the project directory (yours to use)
  state/                    logs, reports, pid files, the runtime override files
  mint/                     the scratch dir for identity rotation
  bin/                      the launcher + the tunnel helpers
  tunnel/                   its own WARP registration (where usque exists)
```

Everything is per-instance: the relay port, the proxy, the pins, the mint
directory, the rescue log and the rotator path. Two instances never share a
file.

## Runtime knobs (all optional)

| env | effect |
|---|---|
| `SAJILO_ROOT` | where the instance lives (default `~/.sajilo`) |
| `SAJILO_RELAY_PORT` | the relay's port (default 43914) |
| `SAJILO_TUNNEL_PORT` | the tunnel's proxy port (default 40003) |
| `SAJILO_BIN` | the runtime binary to use (default: the pinned opencode) |
| `SAJILO_NO_DOWNLOAD` | `1` = never download a runtime, fail instead |
| `SAJILO_FORCE_DOWNLOAD` | `1` = ignore the installed runtime, fetch a private one into the instance |
| `SAJILO_RELAY_SPIN_BUDGET_MS` | how long a request may spin before the relay answers with the last error (default 45000) |
| `SAJILO_RELAY_AUTOMINT=0` | disable the automatic identity rotation |
| `SAJILO_RELAY_EGRESS_ROTATE=0` | the rescue chain refreshes the credential but does not touch the egress |
| `OPENCODE_BIN` | legacy alias for `SAJILO_BIN` |

The `OPENCODE_RELAY_*` names still work everywhere a `SAJILO_RELAY_*` name is
accepted - a renamed instance keeps running on its old configuration.

Live-reloadable files (no restart needed):

| file | effect |
|---|---|
| `<root>/state/direct-egress` | the relay bypasses its proxy and uses the native egress |
| `<root>/state/relay-upstream.txt` | point the relay at a different upstream |
| `<root>/state/sajilo-bin.txt` | the exact runtime binary Sajilo starts |
| `<root>/state/rescue.log` | the rescue chain's transcript |
| `<root>/state/relay-activity.log` | the relay's activity log |

## What the runtime is allowed to do

Everything the live one can - it is the same binary with a different HOME. It
gets its own sessions, its own history, its own project directory, and it can
be pointed at any OpenAI-compatible endpoint:

```bash
# any client can use the relay
curl http://127.0.0.1:43914/v1/models
OPENAI_BASE_URL=http://127.0.0.1:43914/v1 OPENAI_API_KEY=public my-tool
```

## How it was verified

On an Android device (opencode.mobile + proot), against the live instance:
separate DB and sessions, separate tunnel identity, separate exit IP, a lab
rotation leaving the live tunnel's IP untouched, 40/40 + 21/21 + 14/14
chaos-matrix assertions, and a connection-flap loop where the relay answered
200 in ~2 s right after the tunnel dropped.

The relay itself came from
[`dannybyarun/opencode-freebuff-relay-v2`](https://github.com/dannybyarun/opencode-freebuff-relay-v2),
which documents the gateway findings (whitelist shape, quota unit, model
catalogue) in `VERDICT.md` and `OPENCODE-EXTRACTION.md`.

## License

MIT
