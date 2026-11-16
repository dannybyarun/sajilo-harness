// Catalogue drift check.
//
// The relay learns the gateway's live free-model catalogue at startup, but the
// built-in seed in plugin/sajilo-relay.ts is what an offline install starts
// from. This script keeps the seed honest: a new free model, a removed one, or
// a changed token window fails the build.
//
//   bun tools/check-catalogue.ts
//
// An unreachable gateway is not drift - offline builds are legal - so the
// check prints a warning and exits 0 in that case.
import { join } from "node:path"

process.env.SAJILO_RELAY_DIR = join(import.meta.dir, "..", "plugin")

const relay = await import("../plugin/sajilo-relay")
const url =
  process.env.SAJILO_RELAY_CATALOGUE_URL ??
  (process.env.SAJILO_RELAY_UPSTREAM
    ? `${process.env.SAJILO_RELAY_UPSTREAM.replace(/\/inference\/openai$/, "")}/inference/openai/v1/models`
    : "https://opencode.ai/inference/openai/v1/models")

let payload: unknown
try {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  payload = await res.json()
} catch (e) {
  console.log(`catalogue unreachable (${String(e).slice(0, 200)}) - skipping drift check`)
  process.exit(0)
}

const live = relay.modelsFromCatalogue(payload)
if (!Object.keys(live).length) {
  console.log("the live catalogue listed no usable free models - skipping drift check")
  process.exit(0)
}

const seed = relay.SAJILO_MODEL_LIST
const notes: string[] = []

for (const [id, m] of Object.entries(live)) {
  const known = seed[id]
  if (!known) {
    notes.push(`new free model not in the seed: ${id} (${m.limit.context}/${m.limit.output})`)
    continue
  }
  if (known.limit.context !== m.limit.context || known.limit.output !== m.limit.output) {
    notes.push(
      `limit drift ${id}: seed ${known.limit.context}/${known.limit.output}, live ${m.limit.context}/${m.limit.output}`,
    )
  }
  if (known.limit.input !== m.limit.input) {
    notes.push(`input limit drift ${id}: seed ${known.limit.input ?? "-"}, live ${m.limit.input ?? "-"}`)
  }
}

for (const id of Object.keys(seed)) {
  if (!(id in live)) notes.push(`seed model no longer in the free catalogue: ${id}`)
}

if (notes.length) {
  console.error(`${notes.length} catalogue difference(s):`)
  for (const note of notes) console.error(`  - ${note}`)
  console.error("\nThe relay learns this at runtime, but the offline seed must match.")
  console.error("Update SAJILO_MODEL_LIST in plugin/sajilo-relay.ts.")
  process.exit(1)
}

console.log(`catalogue in sync: ${Object.keys(live).length} free models`)
