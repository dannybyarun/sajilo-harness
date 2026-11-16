// mock-429.ts - an upstream that always answers 429.
//
// It exists to prove one thing: when the relay climbs its egress ladder and
// every leg is drained, it rotates THE LEG IT WAS RIDING - and not one of its
// siblings.
//
// The Retry-After is DIFFERENT on every request, because that is what tells
// the relay "each bucket has its own window". A gateway that reports the same
// clock for every bucket is saying something else - one shared window - and
// the relay treats that case differently (it answers with the clock instead
// of rotating, because no rotation can move a shared window).
//
//   bun run mock-429.ts 45000
import { serve } from "bun"

const port = Number(process.argv[2] ?? 45000)
let hits = 0
serve({
  port,
  hostname: "127.0.0.1",
  fetch(req: Request) {
    hits++
    // A different window every time: 5 to 15 minutes, wandering.
    const retryAfter = 300 + ((hits * 137) % 600)
    console.log(
      `[mock] ${req.method} ${new URL(req.url).pathname} -> 429 (hit ${hits}, retry-after ${retryAfter})`,
    )
    return new Response(
      JSON.stringify({ error: { message: "Free usage limit reached" } }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(retryAfter),
        },
      },
    )
  },
})
console.log(`mock 429 upstream on http://127.0.0.1:${port}`)
