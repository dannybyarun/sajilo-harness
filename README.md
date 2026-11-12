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
curl -fsSL https://raw.githubusercontent.com/dannybyarun/sajilo/main/install.sh | bash
```

Or from a clone:

```bash
git clone https://github.com/dannybyarun/sajilo.git
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
