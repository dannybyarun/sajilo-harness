import { beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"

// The rule that decides when a WORKING egress is dead. It is the difference
// between the relay healing itself and the operator rotating a wedged slot by
// hand, so it is worth pinning down: too eager and a lost connection spends a
// WARP registration, too shy and a wedged tunnel keeps costing a timeout on
// every request - which is exactly the failure this was written for.
type Relay = typeof import("../plugin/sajilo-relay")
let relay: Relay

beforeAll(async () => {
  process.env.SAJILO_RELAY_DIR = join(import.meta.dir, "..", "plugin")
  relay = await import("../plugin/sajilo-relay")
})

const MIN = 60_000

describe("when a working egress is declared dead", () => {
  test("one failure is a blip, not a repair", () => {
    expect(relay.legRepairState(1, Infinity)).toBe("counting")
  })

  test("two failures in a row rotate the slot", () => {
    expect(relay.legRepairState(2, Infinity)).toBe("due")
  })

  test("a leg that never failed cannot be 'due'", () => {
    for (const failures of [0, 0.5, 1]) {
      expect(relay.legRepairState(failures, Infinity)).not.toBe("due")
    }
  })

  test("failures during a rotation's warmup are not counted", () => {
    // The rotator took the tunnel down on purpose; a probe landing in that
    // window says nothing about the leg.
    expect(relay.legRepairState(99, 30_000)).toBe("warming")
  })

  test("the warmup ends exactly at its boundary", () => {
    // At the boundary a failure counts again - but a leg that was just
    // repaired is still inside its cooldown, so counting is not rotating.
    expect(relay.legRepairState(1, MIN - 1)).toBe("warming")
    expect(relay.legRepairState(1, MIN)).toBe("counting")
    expect(relay.legRepairState(2, MIN)).toBe("cooldown")
  })

  test("a leg that is still down after a repair waits out the cooldown", () => {
    // Churning registrations for a fault that is not the registration only
    // burns exit IPs (and Cloudflare rate-limits them).
    expect(relay.legRepairState(99, 5 * MIN)).toBe("cooldown")
    expect(relay.legRepairState(99, 10 * MIN - 1)).toBe("cooldown")
    expect(relay.legRepairState(99, 10 * MIN)).toBe("due")
  })

  test("failures are counted again once the cooldown has passed", () => {
    expect(relay.legRepairState(1, 20 * MIN)).toBe("counting")
    expect(relay.legRepairState(2, 20 * MIN)).toBe("due")
  })
})

describe("what counts as a dead working leg", () => {
  test("an answer through WARP is alive", () => {
    expect(relay.legAnswered({ ok: true, ip: "2a09::1", warp: true })).toBe(true)
  })

  test("an answer that is NOT WARP is still alive", () => {
    // The tunnel passed traffic; the exit is simply not a WARP one. Rotating
    // the slot cannot change that, so it must never count as a fault - that
    // would rotate a good leg once per cooldown, forever.
    expect(relay.legAnswered({ ok: false, ip: "1.2.3.4", warp: false, error: "warp=off" })).toBe(true)
  })

  test("a timeout or a malformed trace is dead", () => {
    expect(relay.legAnswered({ ok: false, error: "TimeoutError: The operation timed out." })).toBe(false)
    expect(relay.legAnswered({ ok: false, error: "no ip/warp in the trace answer" })).toBe(false)
  })
})
