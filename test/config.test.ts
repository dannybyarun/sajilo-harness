import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The merge writes the runtime config of the instance: the "sajilo" provider,
// the model map and the default model. Without it the runtime knows no sajilo
// provider at all - the model picker lists nothing and the harness has no
// default model.
type Relay = typeof import("../plugin/sajilo-relay")
let relay: Relay

let home = ""
let configDir = ""
let configFile = ""

// The relay reads HOME, SAJILO_ROOT and the provider mode at CALL time, so a
// temp HOME per test is enough to aim the merge at a scratch directory.
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "sajilo-cfg-"))
  configDir = join(home, ".config", "opencode")
  configFile = join(configDir, "opencode.json")
  process.env.HOME = home
  process.env.SAJILO_ROOT = home
  process.env.SAJILO_RELAY_DIR = join(import.meta.dir, "..", "plugin")
  process.env.SAJILO_RELAY_ACTIVITY_LOG = join(home, "activity.log")
  delete process.env.SAJILO_RELAY_PROVIDER
  delete process.env.OPENCODE_RELAY_PROVIDER
  relay = await import("../plugin/sajilo-relay")
})

afterEach(() => {
  delete process.env.SAJILO_RELAY_PROVIDER
  delete process.env.OPENCODE_RELAY_PROVIDER
})

const readConfig = () => JSON.parse(readFileSync(configFile, "utf8"))

describe("mergeRuntimeConfig", () => {
  test("a fresh instance gets the provider, the models and the default model", () => {
    // No config file at all - the state of a brand new instance.
    expect(existsSync(configFile)).toBe(false)

    relay.mergeRuntimeConfig(43915)

    expect(existsSync(configFile)).toBe(true)
    const cfg = readConfig()
    expect(cfg.provider.sajilo.name).toBe("Sajilo")
    expect(cfg.provider.sajilo.options.baseURL).toBe("http://127.0.0.1:43915/openai/v1")
    // The model picker lists the provider's models - this is the map it reads.
    const models = cfg.provider.sajilo.models
    expect(Object.keys(models).length).toBeGreaterThan(0)
    expect(models["deepseek-v4.1-flash-free"]).toBeDefined()
    // And the harness starts on a model.
    expect(cfg.model).toBe("sajilo/deepseek-v4.1-flash-free")
  })

  test("a pinned model is the one the runtime starts on", () => {
    mkdirSync(join(home, "state"), { recursive: true })
    writeFileSync(join(home, "state", "model.txt"), "glm-5.3-flash-free\n")

    relay.mergeRuntimeConfig(43915)

    expect(readConfig().model).toBe("sajilo/glm-5.3-flash-free")
  })

  test("the user's own config is kept - only our provider is merged in", () => {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      configFile,
      JSON.stringify({
        mcp: { servers: { browse: { type: "local", command: ["browse", "mcp"] } } },
        provider: {
          sajilo: {
            models: {
              "deepseek-v4.1-flash-free": { limit: { context: 999_999, output: 12_345 } },
              "mine-free": { name: "Mine", limit: { context: 1_000, output: 100 } },
            },
          },
        },
        permission: { edit: "ask" },
      }),
    )

    relay.mergeRuntimeConfig(43915)

    const cfg = readConfig()
    expect(cfg.mcp.servers.browse).toBeDefined()
    expect(cfg.permission).toEqual({ edit: "ask" })
    // The user's own limits win over the seed, and their model is kept.
    expect(cfg.provider.sajilo.models["deepseek-v4.1-flash-free"].limit.context).toBe(999_999)
    expect(cfg.provider.sajilo.models["mine-free"].name).toBe("Mine")
    // ...and the seed still fills in everything the config did not say.
    expect(Object.keys(cfg.provider.sajilo.models).length).toBeGreaterThan(1)
  })

  test("a second merge changes nothing", () => {
    relay.mergeRuntimeConfig(43915)
    const first = readFileSync(configFile, "utf8")

    relay.mergeRuntimeConfig(43915)

    expect(readFileSync(configFile, "utf8")).toBe(first)
  })

  test("direct mode writes no config at all", () => {
    process.env.SAJILO_RELAY_PROVIDER = "none"

    relay.mergeRuntimeConfig(43915)

    expect(existsSync(configFile)).toBe(false)
  })

  test("a config that is not valid JSON is left exactly as it is", () => {
    mkdirSync(configDir, { recursive: true })
    const broken = "{ this is not json"
    writeFileSync(configFile, broken)

    relay.mergeRuntimeConfig(43915)

    expect(readFileSync(configFile, "utf8")).toBe(broken)
  })
})
