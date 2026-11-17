import { beforeAll, describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

// The relay is a side-effect-free module at import time (it only reads its
// resources and defines functions), so the pure helpers can be tested directly.
// Point it at the repo's plugin dir before the dynamic import resolves.
type Relay = typeof import("../plugin/sajilo-relay")
let relay: Relay

beforeAll(async () => {
  process.env.SAJILO_RELAY_DIR = join(import.meta.dir, "..", "plugin")
  process.env.SAJILO_RELAY_ACTIVITY_LOG = join(tmpdir(), "sajilo-test-relay-activity.log")
  relay = await import("../plugin/sajilo-relay")
})

const model = (context: number, output: number, name = "M", input?: number) => ({
  name,
  limit: { context, output, ...(input ? { input } : {}) },
})

describe("the built-in seed", () => {
  test("every model is free, named, and carries a usable window", () => {
    const models = relay.SAJILO_MODEL_LIST
    expect(Object.keys(models).length).toBeGreaterThan(5)
    for (const [id, m] of Object.entries(models)) {
      expect(id.endsWith("-free")).toBe(true)
      expect(m.name.length).toBeGreaterThan(0)
      expect(Number.isInteger(m.limit.context)).toBe(true)
      expect(m.limit.context).toBeGreaterThan(0)
      expect(Number.isInteger(m.limit.output)).toBe(true)
      expect(m.limit.output).toBeGreaterThan(0)
      if (m.limit.input !== undefined) {
        expect(Number.isInteger(m.limit.input)).toBe(true)
        expect(m.limit.input).toBeLessThanOrEqual(m.limit.context)
      }
    }
  })

  test("a 1M model is not silently declared as 200k", () => {
    expect(relay.SAJILO_MODEL_LIST["longcat-2.5-free"].limit.context).toBe(1_000_000)
    expect(relay.SAJILO_MODEL_LIST["deepseek-v4.1-flash-free"].limit.context).toBe(200_000)
  })
})

describe("modelsFromCatalogue", () => {
  test("keeps free chat models and their limits, drops everything else", () => {
    const out = relay.modelsFromCatalogue({
      data: [
        { id: "good-free", type: "chat", name: "Good", limit: { context: 1_000_000, output: 32_000 } },
        {
          id: "vision-free",
          type: "chat",
          name: "Vision",
          limit: { context: 262_144, output: 65_536, input: 200_000 },
        },
        { id: "paid", type: "chat", name: "Paid", limit: { context: 1_000_000, output: 32_000 } },
        { id: "image-free", type: "image", name: "Image", limit: { context: 1_000_000, output: 32_000 } },
        { id: "broken-free", type: "chat", name: "Broken", limit: { context: 0, output: 32_000 } },
        { id: "nolimit-free", type: "chat", name: "No limit" },
        { id: "noname-free", type: "chat", limit: { context: 128_000, output: 16_000 } },
      ],
    })
    expect(Object.keys(out).sort()).toEqual(["good-free", "noname-free", "vision-free"])
    expect(out["good-free"]).toEqual(model(1_000_000, 32_000, "Good"))
    expect(out["vision-free"].limit.input).toBe(200_000)
    expect(out["noname-free"].name).toBe("noname-free")
  })

  test("junk payloads produce no models", () => {
    for (const payload of [null, undefined, {}, { data: "nope" }, { data: [] }]) {
      expect(relay.modelsFromCatalogue(payload)).toEqual({})
    }
  })
})

describe("mergeCatalogue", () => {
  test("the live catalogue overrides the seed and new models are added", () => {
    const seed = {
      "a-free": model(200_000, 32_000, "Seed A"),
      "b-free": model(200_000, 32_000, "Seed B"),
    }
    const live = {
      "a-free": model(1_000_000, 64_000, "Live A"),
      "c-free": model(262_144, 65_536, "Live C"),
    }
    expect(relay.mergeCatalogue(seed, live)).toEqual({
      "a-free": model(1_000_000, 64_000, "Live A"),
      "b-free": model(200_000, 32_000, "Seed B"),
      "c-free": model(262_144, 65_536, "Live C"),
    })
  })

  // The cache is written while a model is alive, so it can still list a model
  // the gateway has since retired. It must not come back through that path.
  test("a retired model is not resurrected by an old cache entry", () => {
    const cache = { "minimax-m3.1-flash-free": model(1_000_000, 512_000, "MiniMax") }
    expect(relay.mergeCatalogue({}, cache)["minimax-m3.1-flash-free"]).toBeUndefined()
  })
})

describe("mergeModelMaps", () => {
  test("keeps user keys, keeps user models, and seeds missing ones", () => {
    const seed = { "a-free": model(200_000, 32_000, "A") }
    const existing = {
      "a-free": {
        limit: { context: 999_999, output: 12_345 },
        variants: { high: { reasoningEffort: "high" } },
      },
      "mine-free": { name: "Mine", limit: { context: 1_000, output: 100 } },
    }
    const out = relay.mergeModelMaps(seed, existing)
    expect(out["a-free"].limit).toEqual({ context: 999_999, output: 12_345 })
    expect(out["a-free"].variants).toEqual({ high: { reasoningEffort: "high" } })
    expect(out["mine-free"]).toEqual(existing["mine-free"])
  })

  test("an empty config still gets the whole seed", () => {
    expect(relay.mergeModelMaps(relay.SAJILO_MODEL_LIST, {})).toEqual(relay.SAJILO_MODEL_LIST)
  })

  // The gateway removed minimax-m3.1-flash-free on 2026-11-17 and answers 410
  // Gone for it. An older config still carries it, and "keep the user's keys"
  // must not turn that into "keep offering a model that no longer answers".
  test("a model the gateway retired is dropped, not kept as an existing key", () => {
    const existing = {
      "minimax-m3.1-flash-free": {
        name: "MiniMax M3.1 Flash",
        limit: { context: 1_000_000, output: 512_000 },
        variants: { high: { reasoningEffort: "high" } },
      },
    }
    const out = relay.mergeModelMaps(relay.SAJILO_MODEL_LIST, existing)
    expect(out["minimax-m3.1-flash-free"]).toBeUndefined()
    expect(out["deepseek-v4.1-flash-free"]).toBeDefined()
  })
})

describe("parseModelsCache", () => {
  test("accepts a good cache and drops unusable entries", () => {
    const cache = relay.parseModelsCache(
      JSON.stringify({
        fetchedAt: 1_700_000_000_000,
        models: {
          "a-free": { name: "A", limit: { context: 1_000_000, output: 64_000 } },
          "bad-free": { name: "Bad", limit: { context: "lots", output: 1 } },
          "nofree": { name: "No limit" },
        },
      }),
    )
    expect(cache?.fetchedAt).toBe(1_700_000_000_000)
    expect(Object.keys(cache!.models)).toEqual(["a-free"])
  })

  test("invalid JSON, missing fields and empty maps are no cache", () => {
    for (const raw of ["", "not json", "{}", '{"fetchedAt":1,"models":{}}', '{"models":{"a-free":{}}}']) {
      expect(relay.parseModelsCache(raw)).toBeNull()
    }
  })
})

describe("freeModelList", () => {
  test("leads with the default model exactly once and publishes the real window", () => {
    const models = {
      "deepseek-v4.1-flash-free": model(200_000, 32_000, "DeepSeek"),
      "beam-free": model(1_048_576, 131_072, "Beam"),
    }
    const list = relay.freeModelList(models)
    expect(list.filter((m) => m.id === "deepseek-v4.1-flash-free")).toHaveLength(1)
    expect(list[0].id).toBe("deepseek-v4.1-flash-free")
    const beam = list.find((m) => m.id === "beam-free")!
    expect(beam.context_length).toBe(1_048_576)
    expect(beam.max_completion_tokens).toBe(131_072)
    for (const entry of list) {
      expect(entry.object).toBe("model")
      expect(entry.owned_by).toBe("sajilo")
      expect(entry.context_length).toBeGreaterThan(0)
    }
  })
})

describe("wantsJson", () => {
  test("response_format is the signal a structured-output caller sends", () => {
    expect(relay.wantsJson({ response_format: { type: "json_object" } })).toBe(true)
    expect(relay.wantsJson({ response_format: { type: "json_schema", json_schema: {} } })).toBe(true)
  })

  test("an ordinary chat request is not JSON mode", () => {
    expect(relay.wantsJson({})).toBe(false)
    expect(relay.wantsJson({ response_format: { type: "text" } })).toBe(false)
    expect(relay.wantsJson({ response_format: null })).toBe(false)
    expect(relay.wantsJson(null)).toBe(false)
    expect(relay.wantsJson("nope")).toBe(false)
  })

  test("the environment flag forces it for a client that cannot ask", () => {
    const before = process.env.SAJILO_RELAY_JSON
    try {
      for (const value of ["1", "true", "on", "yes", "TRUE"]) {
        process.env.SAJILO_RELAY_JSON = value
        expect(relay.wantsJson({})).toBe(true)
      }
      for (const value of ["0", "false", "", "off"]) {
        process.env.SAJILO_RELAY_JSON = value
        expect(relay.wantsJson({})).toBe(false)
      }
    } finally {
      if (before === undefined) delete process.env.SAJILO_RELAY_JSON
      else process.env.SAJILO_RELAY_JSON = before
    }
  })
})

describe("unwrapJson", () => {
  test("a correct answer is returned untouched", () => {
    expect(relay.unwrapJson('{"items":[]}')).toBe('{"items":[]}')
    expect(relay.unwrapJson("  [1,2,3]\n")).toBe("[1,2,3]")
  })

  test("a fenced answer is unwrapped", () => {
    expect(relay.unwrapJson('```json\n{"items":[{"start":4}]}\n```')).toBe('{"items":[{"start":4}]}')
    expect(relay.unwrapJson('```\n{"items":[]}\n```')).toBe('{"items":[]}')
  })

  test("an object behind a sentence is extracted", () => {
    expect(relay.unwrapJson('Sure! Here you go: {"items":[{"start":4}]} - enjoy.')).toBe(
      '{"items":[{"start":4}]}',
    )
  })

  test("a nested array mentioned before the real object does not steal the answer", () => {
    const answer = '{"items":[{"start":4,"hashtags":["#a","#b"]}]}'
    expect(relay.unwrapJson(`Tags like ["#a","#b"] then the result: ${answer}`)).toBe(answer)
    expect(relay.unwrapJson(`["#a","#b"]\n\n{"items":[]}`)).toBe('{"items":[]}')
  })

  test("a bare hashtag list with no real object is still returned, not prose", () => {
    expect(relay.unwrapJson('The tags were ["#a","#b"].')).toBe('["#a","#b"]')
  })

  test("braces inside strings do not confuse the scan", () => {
    const answer = '{"why":"he said {wow} and [then] left","items":[]}'
    expect(relay.unwrapJson(`The moment: ${answer}`)).toBe(answer)
  })

  test("text with no JSON at all is still returned, trimmed", () => {
    expect(relay.unwrapJson("  I cannot help with that.  ")).toBe("I cannot help with that.")
    expect(relay.unwrapJson("")).toBe("")
  })
})
