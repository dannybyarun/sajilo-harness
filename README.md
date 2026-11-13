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
- the **limit reset** (a 429 means this identity's window is empty, so the
  relay gets a fresh identity - a new egress and a new session/project pair
  - and retries **the same model**; it never rotates to a different one),
- the **refill wait** (the gateway says when the window refills, so a short
  wait is cheaper than a reset),
- the **egress ladder** (proxied path first, then the device's native
  egress - a dead proxy no longer kills the request),
- the **keep-working ceiling** (a request is never abandoned - the relay works
  for up to 4 minutes, then answers a retryable 503),
- the **no-quota-error rule** (a 429 is never passed on: the caller gets the
  model it asked for, or a retryable 503 - never "Free usage limit reached").

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
| **tunnel** | the rotatable WARP tunnel is **installed if it is missing** - `usque`, a user-space WARP client: one binary, one config file, one HTTP proxy. **No administrator rights, no service, no UAC.** Rotating it is registering a new anonymous account |

The tunnel step is what makes a **new exit IP** possible, and a new exit IP is
a new quota bucket. There are two ways to get one:

- **`usque`** - a user-space MASQUE client. Installing it is downloading a
  binary; rotating it is writing a config file. No admin, ever.
- the **Cloudflare WARP app** - a Windows *service*. Its proxy is fine, but
  re-registering it is a service operation, so it needs admin. It is used
  only when it is already there.

The step is **best effort**: a machine that cannot have the tunnel still gets
a working relay - it resets the identity instead of rotating the IP. Skip it
with `SAJILO_SKIP_TUNNEL=1`.

One honest caveat: Cloudflare sometimes hands the same address to two
registrations in the same colo, so a rotation is *usually* a new exit IP. The
rotator retries until the address actually changes, and reports the
registration id as the certain signal.

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
  is not. And it is always the model that was asked for - the relay resets
  the limit instead of rotating models.
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

The pin is a preference, not a straitjacket: if the pinned model's window is
empty, the relay **resets the limit** (a fresh identity) and keeps serving
that same model - it never answers with a different one.

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
behaviour: the gateway whitelist, the limit reset, the egress ladder, the
keep-working ceiling, and the rule that a rate-limit error never reaches the
caller.

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
window that a one-tool agent uses comfortably.

When the window is empty, the relay does **not** give up and does **not** swap
models. It keeps working:

1. the 429 carries a `Retry-After`, so the relay knows exactly when the
   window refills - a short wait is cheaper than anything else,
2. otherwise it **resets the identity**: a new egress IP and a new
   session/project pair, which is a fresh bucket (measured: 14-22 s, and the
   requested model serves again immediately),
3. and it retries **the same model** every time - as many times as it takes.

The relay keeps going for as long as the client stays connected (4 minutes by
default - the ceiling Bun's idle timeout allows). If the network itself dies, the egress is repaired in the
background and the request is retried - it is never abandoned.

The caller never sees a rate-limit error. If the client is still there when
the ceiling is reached, the relay answers **503** with the gateway's own
`Retry-After` - a retryable status that is not a quota error - and the reset
keeps running in the background, so the next attempt lands on a fresh
identity.

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
  model that actually served it (always the model that was asked for - the
  relay resets the limit instead of rotating models, and the agent reports
  the truth - `Sajilo, deepseek-v4.1-flash-free`),
- a **`# Sajilo` section** carries Sajilo's own rules.

Everything else - the sections, the tool catalog, the MCP tools - is whatever
the runtime says it is.

`plugin/resources/sajilo-overlay.md` is that layer, and it is yours: the
`# Identity` block is the sentence that replaces the first line, and the
`# Rules` block becomes the `# Sajilo` section. Edit it, and the next request
uses it. (The gateway accepts both - measured, not assumed.)

## MCP and other plugins

Add them exactly the way you add them to opencode:

```bash
sajilo mcp list
sajilo mcp add browse -- browse mcp
```

The instance's config is `~/.sajilo/home/.config/opencode/opencode.json(c)` -
the same file opencode uses, so `mcp add`, permissions, agents and commands all
work normally.

**The launcher never writes that file.** It used to, and it wiped everything
you had added. Now the relay plugin *merges* the sajilo provider into it at
startup and leaves every other key alone:

```jsonc
{
  "mcp": { "servers": { "browse": { "type": "local", "command": ["browse", "mcp"] } } },
  "provider": { "sajilo": { "name": "Sajilo", "options": { "baseURL": "http://127.0.0.1:43914/openai/v1" } } },
  "model": "sajilo/deepseek-v4.1-flash-free"
}
```

Your MCP, your permissions, your agents - and Sajilo's provider on top.

One trap worth knowing: **a UTF-8 BOM in the config file makes opencode ignore
the whole file.** PowerShell's `Set-Content -Encoding utf8` writes one, and so
do some Windows editors. If your MCP servers mysteriously disappear, check the
first three bytes (`EF BB BF` is a BOM) - the merger strips it when it writes,
but it cannot save a file it cannot parse.

MCP tools are *deferred* by the runtime (discovered on demand rather than sent
upfront), so they never bloat the request - the relay needs no special
handling for them.

## What it logs

Everything the relay decides, in `<root>/state/`:

| file | what it holds |
|---|---|
| `relay-activity.log` | every decision: the model each request chose, every upstream status, every 429 and when it refills, every ladder move, every reset, every harness capture, every config merge |
| `relay-last-incoming.json` | the last request body exactly as the client sent it |
| `relay-last-transformed.json` | the same body after the relay rewrote it into the agent class |
| `relay-last-meta.txt` | pathname, model, and the size of both |
| `rescue.log` | the reset transcript: what it rotated, what it minted |

`sajilo doctor` reads them back and gives the summary:

```
reset record
  ok    52 upstream 200s, 57 model 429s, 79 ladder climbs, 0/0 resets landed (last 400 log lines)
  warn  models hitting 429 most: deepseek-v4.1-flash-free:9, mimo-v2.6-flash-free:7
  ok    last success: 2026-11-13T04:55:03
  ok    every request was answered by the model it asked for
```

That is usually the fastest way to answer "is it Sajilo or the quota?": if
the models are 429ing one after another it is the allowance; if the harness
probe fails while the models are fine it is the harness. The last line is the
canary: if it ever fails, something rotated a model again.

## Platform matrix

| | Linux / macOS / WSL | Windows |
|---|---|---|
| separate HOME, DB, sessions, project | yes | yes |
| own relay (port 43914) with ladder/budget/reset | yes | yes |
| own **rotatable** WARP tunnel | yes (`usque`) | yes (`usque` - no admin) |
| egress recovery by rotating the IP | yes | yes - `usque-rotate.cmd` gives a new exit IP, no admin |
| the live opencode is unaffected | yes | yes |

On Windows the tunnel is **Cloudflare WARP** (`warp-svc.exe`, in proxy mode on
`127.0.0.1:40000`). The relay's proxied leg is whatever proxy it actually
uses - `SAJILO_RELAY_PROXY`, else the ambient `HTTPS_PROXY` that Bun's fetch
honours - and the **direct leg** is the device's own route.

Bun below 1.4 ignores `NO_PROXY` entirely (measured: `NO_PROXY=host`,
`NO_PROXY=*`, `NO_PROXY=.host` and `proxy:''` all tunnelled), so the direct
leg cannot simply bypass the proxy - both legs would come out of the same
exit IP and the ladder would have nothing to climb. It takes an explicit
proxy that connects **directly** instead:

```bash
SAJILO_RELAY_DIRECT_PROXY=http://127.0.0.1:40001
```

The relay starts that proxy itself: the opencode-warp stack's
`egress-proxy.py --upstream direct`, which opens a raw socket (no proxy in
between). Because the shim only tunnels the bytes, the TLS fingerprint is
still Bun's - which the gateway's whitelist requires.

Measured on this machine:

| leg | exit | |
|---|---|---|
| the tunnel (`40000`) | `2a09:bac5:4e7d:16b4::243:85` | `warp=on` |
| the direct shim (`40001`) | `2400:1a00:4b26:e77b:19f1:ef89:72ee:8d38` | `warp=off` - the ISP |

Two exits, two quota buckets. `sajilo doctor` prints both and says plainly
whether they are really two:

```
egress
  ok    proxied leg: http://127.0.0.1:40000 (the ambient proxy the relay inherits) - a drained bucket can be climbed over
  ok    exit through the proxy: ip=2a09:bac5:4e7d:16b4::243:85 warp=on
  ok    direct exit: ip=2400:1a00:4b26:e77b:19f1:ef89:72ee:8d38 warp=off - a second bucket (via http://127.0.0.1:40001)
```

A headless client needs nothing special. The relay runs on its own, without
the TUI:

```bash
sajilo relay                       # the provider, headless
bun run <root>/bin/sajilo-relay.ts # the same thing, directly
```

```bash
OPENAI_BASE_URL=http://127.0.0.1:43914/v1 OPENAI_API_KEY=public my-client
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
directory, the reset log and the rotator path. Two instances never share a
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
| `SAJILO_RELAY_PROXY` | the proxy for the tunnel leg of the egress ladder (default: the ambient `HTTPS_PROXY`) |
| `SAJILO_RELAY_DIRECT_PROXY` | an explicit proxy for the direct leg - one that connects directly (the opencode-warp stack's `egress-proxy.py --upstream direct`). The relay starts it if it is not running. Without it the direct leg stays in the tunnel on Bun < 1.4, because `NO_PROXY` is ignored there |
| `SAJILO_RELAY_KEEP_WORKING_MS` | how long the relay keeps working on one request - waiting out refills, resetting the identity, rotating the egress - before it answers a retryable 503 (default 240000; Bun's idle cap is 255 s, so a longer hold would have its socket cut) |
| `SAJILO_RELAY_MAX_RESETS` | a safety valve on the resets per request; `0` = unlimited, the ceiling above is the only limit (default 0) |
| `SAJILO_RELAY_WAIT_MAX_SECONDS` | the longest refill the relay waits out instead of resetting the identity (default 45) |
| `SAJILO_RELAY_LONG_WAIT_MAX_SECONDS` | the longest single wait the relay will hold a request for, once a reset has failed to bring the window back (default 600) |
| `SAJILO_RELAY_RESET_COOLDOWN_MS` | how long the relay waits before starting a NEW reset (a storm of 429s shares one reset) (default 20000) |
| `SAJILO_RELAY_AUTOMINT=0` | disable the automatic identity rotation |
| `SAJILO_RELAY_EGRESS_ROTATE=0` | the reset refreshes the credential but does not touch the egress |
| `SAJILO_SKIP_TUNNEL=1` | the installer does not install the rotatable WARP tunnel (the relay resets the identity instead) |
| `OPENCODE_BIN` | legacy alias for `SAJILO_BIN` |

The `OPENCODE_RELAY_*` names still work everywhere a `SAJILO_RELAY_*` name is
accepted - a renamed instance keeps running on its old configuration.

Live-reloadable files (no restart needed):

| file | effect |
|---|---|
| `<root>/state/direct-egress` | the relay bypasses its proxy and uses the native egress |
| `<root>/state/relay-upstream.txt` | point the relay at a different upstream |
| `<root>/state/sajilo-bin.txt` | the exact runtime binary Sajilo starts |
| `<root>/state/rescue.log` | the reset transcript |
| `<root>/state/relay-activity.log` | the relay's activity log |

`sajilo mint` resets the limit on demand: it mints a fresh session/project
pair (skipping the mint cooldown), which is a fresh quota bucket for every
model.

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

On this instance (Windows, WARP tunnel, the live gateway):

- the reset path, end to end: a 429 with `Retry-After: 7` -> the relay waits
  7.1 s -> retries **the same model** -> the caller gets `200` and the model
  it asked for. The mock upstream saw `deepseek-v4.1-flash-free` on every
  single attempt.
- the keep-working path: three consecutive 429s -> the relay waited each
  one out and served the fourth attempt (200 after 21.1 s, same model); and
  an upstream that 429s *forever* -> the relay made 11 attempts in 90 s,
  all of them for the same model, and was still working when the client's
  own timeout fired.
- the give-up path: a gateway that 429s every time -> the caller gets
  `503` + `retry-after`, never a 429 and never "Free usage limit reached".
- the reset itself: a fresh pair is minted in 14-22 s, and the requested
  model serves again immediately (18/20, 77/81 and 12/12 of the requests in
  the 90 s after a reset were served by the requested model).
- the old pool rotation, for comparison: it answered 15% of all requests with
  a model nobody had asked for, and burned 2162 failed upstream calls -
  each one re-uploading the whole (up to 680 KB) body against an allowance
  that is weight-based.

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
