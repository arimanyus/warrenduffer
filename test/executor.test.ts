import "./helpers/env.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { LiveExecutor } from "../src/executor/live.js";
import { OrderPending, OrderRejected, type Fill, type PlaceIntent } from "../src/executor/types.js";
import { useVirtualClock } from "../src/time.js";
import { FakeBroker } from "./helpers/fake-broker.js";

const t0 = Date.parse("2026-09-15T05:00:00Z");
const vclock = useVirtualClock(t0);
let now = t0;
const advance = (ms: number) => vclock.set((now += ms));

function intent(o: Partial<PlaceIntent> = {}): PlaceIntent {
  return {
    symbol: "INFY",
    token: "1",
    segment: "nse_cm",
    tradingSymbol: "INFY-EQ",
    side: "buy",
    qty: 10,
    price: 1500,
    kind: "entry",
    tag: `wde${Math.random().toString(36).slice(2, 10)}`,
    decisionId: null,
    leg: "equity",
    tier: "B",
    ...o,
  };
}

let broker: FakeBroker;
let exec: LiveExecutor;
let fills: Fill[];

async function poll(): Promise<void> {
  advance(2000);
  await exec.tick(new Map());
}

beforeEach(() => {
  broker = new FakeBroker([{ symbol: "INFY", token: "1" }]);
  exec = new LiveExecutor(broker);
  fills = [];
  exec.onFill = (f) => fills.push(f);
});

describe("LiveExecutor.place", () => {
  it("tracks an accepted order and books its fill from the order book", async () => {
    const o = await exec.place(intent());
    assert.equal(o.confirmed, true);
    broker.fill(o.brokerId!, 10, 1499.5);
    await poll();
    assert.equal(fills.length, 1);
    assert.deepEqual([fills[0].qty, fills[0].price], [10, 1499.5]);
    assert.equal(exec.orders.size, 0);
  });

  it("throws OrderRejected and tracks nothing when the broker refuses", async () => {
    broker.placeModes.push("reject");
    await assert.rejects(exec.place(intent()), OrderRejected);
    assert.equal(exec.orders.size, 0);
  });

  it("keeps an order whose place call timed out after the broker took it, and confirms it by tag", async () => {
    broker.placeModes.push("accept-then-throw");
    const o = await exec.place(intent());
    assert.equal(o.confirmed, false);
    assert.equal(exec.orders.size, 1);
    await poll();
    assert.equal(o.confirmed, true);
    assert.equal(o.brokerId, broker.book[0].orderId);
    broker.fill(o.brokerId!);
    await poll();
    assert.equal(fills.length, 1);
  });

  it("gives up on an ambiguous order the book never shows", async () => {
    broker.placeModes.push("throw");
    const o = await exec.place(intent());
    await poll();
    assert.equal(exec.orders.size, 1, "one poll is not enough to give up");
    for (let i = 0; i < 7; i++) await poll();
    assert.equal(exec.orders.size, 0);
    assert.equal(o.status, "rejected");
  });

  it("cancels a given-up order that surfaces in the book later", async () => {
    broker.placeModes.push("throw");
    const o = await exec.place(intent({ kind: "stop", side: "sell", price: 1495, trigger: 1497, tag: "wdslate1" }));
    for (let i = 0; i < 9; i++) await poll();
    assert.equal(o.status, "rejected");
    const late = await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "sell", qty: 10, price: 1495, orderType: "SL-L", trigger: 1497, tag: "wdslate1" });
    await poll();
    assert.equal(broker.book.find((b) => b.orderId === late.orderId)!.status, "cancelled");
  });

  it("does not match an ambiguous order to a row with a different quantity or an empty tag", async () => {
    broker.placeModes.push("throw");
    const o = await exec.place(intent({ tag: "wdeqty1" }));
    await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "buy", qty: 3, price: 1500, tag: "wdeqty1" });
    await poll();
    assert.equal(o.confirmed, false);
    broker.placeModes.push("throw");
    const blank = await exec.place(intent({ tag: "" }));
    await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "buy", qty: 10, price: 1500, tag: "" });
    await poll();
    assert.equal(blank.confirmed, false);
  });

  it("does not book a full fill from a 'partially traded' status", async () => {
    const o = await exec.place(intent());
    const row = broker.book.find((b) => b.orderId === o.brokerId)!;
    row.filledQty = 3;
    row.status = "partially traded";
    await poll();
    assert.equal(fills.reduce((s, f) => s + f.qty, 0), 3);
    assert.equal(exec.orders.size, 1);
  });

  it("never matches an ambiguous order to an order it already tracked", async () => {
    const tag = "wdeduplicate";
    const first = await exec.place(intent({ tag }));
    broker.fill(first.brokerId!);
    await poll();
    broker.placeModes.push("throw");
    const second = await exec.place(intent({ tag }));
    await poll();
    assert.equal(second.confirmed, false);
  });
});

describe("LiveExecutor.cancel", () => {
  it("defers a cancel on an unconfirmed order and sends it once confirmed", async () => {
    broker.placeModes.push("accept-then-throw");
    const o = await exec.place(intent());
    await assert.rejects(exec.cancel(o), OrderPending);
    assert.equal(o.cancelRequested, true);
    await poll();
    assert.equal(broker.book[0].status, "cancelled");
    assert.equal(exec.orders.size, 0);
  });

  it("books a partial fill that landed before the cancel", async () => {
    const o = await exec.place(intent());
    broker.fill(o.brokerId!, 4, 1500);
    await exec.cancel(o);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].qty, 4);
    assert.equal(exec.orders.size, 0);
  });

  it("books the fill and still throws when cancel loses the race to a full fill", async () => {
    const o = await exec.place(intent());
    broker.fill(o.brokerId!);
    await assert.rejects(exec.cancel(o));
    assert.equal(fills.length, 1);
    assert.equal(exec.orders.size, 0);
  });

  it("cancelAll swallows per-order failures", async () => {
    await exec.place(intent());
    broker.placeModes.push("accept-then-throw");
    await exec.place(intent());
    await exec.cancelAll("entry");
    assert.equal(exec.orders.size, 1, "the unconfirmed one waits for confirmation");
  });
});

describe("LiveExecutor stops", () => {
  it("marks a stop as triggered when the broker moves it to open", async () => {
    const o = await exec.place(intent({ kind: "stop", side: "sell", price: 1495, trigger: 1497, tag: "wds1n1" }));
    assert.equal(o.orderType, "SL-L");
    await poll();
    assert.equal(o.triggeredAt, null);
    broker.trigger(o.brokerId!);
    await poll();
    assert.equal(o.triggeredAt, now);
  });

  it("keeps the trigger and order type when only the quantity changes", async () => {
    const o = await exec.place(intent({ kind: "stop", side: "sell", price: 1495, trigger: 1497, tag: "wds1n2" }));
    await exec.modify(o, o.price, undefined, 5);
    const call = broker.calls.find((c) => c.method === "modify")!.args as { trigger?: number; orderType?: string; qty: number };
    assert.deepEqual([call.trigger, call.orderType, call.qty], [1497, "SL-L", 5]);
  });

  it("refuses to modify an unconfirmed order", async () => {
    broker.placeModes.push("throw");
    const o = await exec.place(intent({ kind: "stop", side: "sell", price: 1495, trigger: 1497, tag: "wds1n3" }));
    await assert.rejects(exec.modify(o, 1490, 1492), OrderPending);
  });
});

describe("LiveExecutor.adopt", () => {
  it("tracks an existing broker order and books later fills against it", async () => {
    const res = await broker.place({ segment: "nse_cm", tradingSymbol: "INFY-EQ", side: "sell", qty: 10, price: 1495, orderType: "SL-L", trigger: 1497, tag: "wds9n1" });
    const o = exec.adopt(intent({ kind: "stop", side: "sell", price: 1495, trigger: 1497, tag: "wds9n1", orderType: "SL-L" }), res.orderId!, 0);
    broker.fill(res.orderId!, 10, 1496);
    await poll();
    assert.equal(fills[0].order, o);
  });
});
