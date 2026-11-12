// sajilo-stress.mjs - hammer the Sajilo relay and watch it work.
//
//   bun run tools/sajilo-stress.mjs --url http://127.0.0.1:43914/v1 \
//        --model deepseek-v4.1-flash-free --phase burst --concurrency 12
//
// Phases:
//   burst    N requests at once, same model - does the pool rotate?
//   heavy    N requests at once with a big body - the allowance is weighted
//   sustain  keep going for a while - does the rescue chain kick in?
//
// Every request reports: status, which model actually answered (the
// x-sajilo-model header), how long it took, and the first line of any error.

const args = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (a.startsWith("--")) {
    const key = a.slice(2)
    const next = process.argv[i + 1]
    if (next && !next.startsWith("--")) {
      args.set(key, next)
      i++
    } else {
      args.set(key, true)
    }
  }
}

const URL = String(args.get("url") ?? "http://127.0.0.1:43914/v1")
const MODEL = String(args.get("model") ?? "deepseek-v4.1-flash-free")
const PHASE = String(args.get("phase") ?? "burst")
const CONCURRENCY = Number(args.get("concurrency") ?? 8)
const COUNT = Number(args.get("count") ?? 12)
const SECONDS = Number(args.get("seconds") ?? 120)
const KIB = Number(args.get("kib") ?? 64)
const PROMPT = String(
  args.get("prompt") ?? "Reply with exactly: STRESS OK",
)

const stats = {
  sent: 0,
  ok: 0,
  quota: 0,
  other: 0,
  served: new Map(),
  errors: new Map(),
  ms: [],
}

function note(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

async function one(i) {
  const big = PHASE === "heavy" ? "y".repeat(KIB * 1024) : ""
  const body = {
    model: MODEL,
    messages: [
      ...(big ? [{ role: "system", content: big }] : []),
      { role: "user", content: `${PROMPT} (#${i})` },
    ],
    stream: false,
  }
  const t0 = Date.now()
  stats.sent++
  try {
    const r = await fetch(`${URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    const ms = Date.now() - t0
    stats.ms.push(ms)
    const served = r.headers.get("x-sajilo-model") ?? "?"
    if (r.status === 200) {
      stats.ok++
      note(stats.served, served)
      process.stdout.write(
        `  ${String(i).padStart(3)} 200  ${served.padEnd(28)} ${ms}ms\n`,
      )
    } else {
      if (r.status === 429) stats.quota++
      else stats.other++
      let reason = `HTTP ${r.status}`
      try {
        const j = JSON.parse(text)
        reason = j?.error?.message ?? j?.error ?? reason
      } catch {
        /* not json */
      }
      note(stats.errors, String(reason).slice(0, 60))
      process.stdout.write(
        `  ${String(i).padStart(3)} ${r.status} ${String(reason).slice(0, 56).padEnd(56)} ${ms}ms\n`,
      )
    }
  } catch (e) {
    stats.other++
    note(stats.errors, String(e).slice(0, 60))
    process.stdout.write(`  ${String(i).padStart(3)} ERR ${String(e).slice(0, 60)}\n`)
  }
}

async function pool(items, width) {
  let next = 0
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      await one(i)
    }
  })
  await Promise.all(workers)
}

console.log(`sajilo stress - phase ${PHASE}`)
console.log(`  url        : ${URL}`)
console.log(`  model      : ${MODEL}`)
console.log(
  `  shape      : ${PHASE === "sustain" ? `${SECONDS}s sustained` : `${COUNT} requests, ${CONCURRENCY} at a time`}${PHASE === "heavy" ? `, ${KIB} KiB bodies` : ""}\n`,
)

const t0 = Date.now()
if (PHASE === "sustain") {
  const deadline = Date.now() + SECONDS * 1000
  let i = 0
  while (Date.now() < deadline) {
    await pool([i, i + 1, i + 2, i + 3, i + 4, i + 5], CONCURRENCY)
    i += 6
  }
} else {
  await pool(
    Array.from({ length: COUNT }, (_, i) => i),
    CONCURRENCY,
  )
}

const secs = ((Date.now() - t0) / 1000).toFixed(1)
const avg = stats.ms.length
  ? Math.round(stats.ms.reduce((a, b) => a + b, 0) / stats.ms.length)
  : 0
console.log(`\n--- ${stats.sent} requests in ${secs}s (avg ${avg}ms) ---`)
console.log(`  200      : ${stats.ok}`)
console.log(`  429      : ${stats.quota}   (the free allowance)`)
console.log(`  other    : ${stats.other}`)
if (stats.served.size) {
  console.log(`\n  who answered:`)
  for (const [m, n] of [...stats.served].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(n).padStart(4)}  ${m}`)
}
if (stats.errors.size) {
  console.log(`\n  errors:`)
  for (const [e, n] of [...stats.errors].sort((a, b) => b[1] - a[1]))
    console.log(`    ${String(n).padStart(4)}  ${e}`)
}
