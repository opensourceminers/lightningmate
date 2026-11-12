# LightningMate — Autopilot & Strategy system (complete explanation)

> Self-contained brief for review by another AI. LightningMate is an Umbrel app that
> manages a Lightning Network (LND) node: it sets routing fees, runs rebalances,
> opens channels, and buys/sells channel liquidity on the Amboss Magma marketplace.
> All fund-moving actions are off by default and gated behind an admin macaroon.
> This document explains how the **Autopilot** and its **Strategy** presets work today,
> and asks where they could be improved.

Reader does not need Lightning expertise, but these terms matter:

- **Channel**: a 2-party payment balance. `local_balance` = funds on our side (we can
  send/forward *out*), `remote_balance` = funds on their side (we can receive/forward *in*).
- **localRatio** = local / (local + remote), 0..1. High = lots of outbound; low = drained.
- **Forward / routing**: someone pays *through* our node; we earn a **fee** on the amount.
- **Fee model (LND)**: per channel we set `fee_rate` in **ppm** (parts per million of the
  forwarded amount) and a flat **`base_fee`** in millisats charged per forward regardless
  of size. LND's pathfinding avoids expensive channels — and weights `base_fee` heavily,
  so a nonzero base fee disproportionately loses small and multi-hop routes.
- **Rebalance**: pay a circular payment to move our own liquidity from one channel to
  another (costs a fee). Used to refill drained channels so they can route again.
- **Magma**: a marketplace where we can *sell* outbound liquidity (someone pays us a lease
  fee to open a channel to them) or *buy* inbound.

---

## 1. Big picture

The Autopilot is a single scheduled loop. Every `intervalMinutes` (default **30 min**),
if enabled, it runs four independent sub-autopilots in order:

1. **Fees** — recompute and apply each channel's outbound `fee_rate` + `base_fee`.
2. **Rebalancing** — run profitable circular rebalances to refill channels.
3. **Channels** — open a channel to a well-scored peer if on-chain funds allow. It never
   closes one: closing is the operator's (decided 2026-11-10). The close list (Channels →
   Channels to close) ranks what earns too little, and an alert names the capital in channels
   that routed nothing in 60 days while their peer was there (the list is computed again in the
   background at most every 6 h). An open to a node is one at a time, whether the autopilot or
   a click makes it; with LND's pending channels unread no automatic open is made to a
   suggestion.
4. **Magma** — keep our offer fundable and well-formed, reprice/relist it if asked, optionally
   auto-close finished leases (that part runs with selling off too, so a node that stopped
   selling still gets its sold channels closed as their leases end). (Orders themselves are
   fulfilled by a separate 45-second order lane, never by this loop.) Off by default: selling
   is opt-in (Selling).

Each sub-autopilot has its own on/off switch and detailed settings. Every action is a
**dry-run recommendation** first (shown in the UI), and only applied when its autopilot is
on and the change passes safety guards.

On top of the four sub-autopilots sits **Strategy** — three one-click presets that
configure fees, rebalancing and channel opening coherently (Section 3). No preset touches
Magma selling.

### Deadlines, locks and the run history

LND's gRPC calls carry no deadline (the `lightning` library builds its clients without
one and offers no hook to add one), so the autopilot sets its own. Each stage of a run has
a deadline — 15 min; the rebalancing stage 15 min plus each refill's payment time
(`REBALANCE_HARD_TIMEOUT_MS`) — and so do the lease-promise check, a manual fee write, the
check of refills still in flight, the offer price check and the purchase follow-up (5 min
each) and every order-lane pass (5 min). A stage that doesn't finish in time is recorded as
its area's error ("… did not finish in 15 min — LND or Amboss didn't answer; it was given
up"), and the run goes on to its other stages and ends: the next runs, "Run once now" and
manual fee writes are not held up until a restart any more. The given-up work can't be
cancelled, but whatever it still does when the call answers late writes nothing (no fee
write, payment, open, offer write or order step) — except the one it was waiting on: an
open, a refill or a fee write that goes through when LND answers late gets a run-history
line of its own ("finished after the channels stage was given up"), and the area's decision
says what happened instead of "did not finish" (unless a later run has decided something
else since). A rebalancing stage given up while its payment is out keeps the refill lock
until LND answers: the rebalancing decision and a refused manual refill say so ("a refill of
the given-up rebalancing stage is still running — LND hasn't answered"), and after 10
minutes it is an alert, as is a manual refill holding it that long. An order-lane pass that
is given up ("… did not finish in 5 min — LND or Amboss didn't answer, or a buyer couldn't
be reached in time") frees the lane; the next pass leaves alone an order whose step the
given-up one still waits on and goes on with the others; at most two given-up passes wait
at once, then none starts until one ends.

Fee writes have a lock of their own, apart from the run's: the run's fee and max_htlc
stages (each writes the whole policy back, so one must never land between the other's read
and write), the 10-minute lease-promise check and a manual Apply or fee set by hand. A
scheduled run that comes due while the lease-promise check or an Apply is under way runs —
its fee stage waits for the lock — instead of being skipped without a trace, and the run
the selling switch-on kicks is not lost either. A manual fee write that finds
the lock taken answers "Fees are being written right now … — try again in a moment".

The run history keeps one line for the same successful changes run after run (the same fee
or max_htlc change on the same channels: "35 times in a row, since 19h ago"); a failed write,
a fee set by hand, a refill, an open, a Magma action, a stage error and what a stage finished
after it was given up always get a line of their own. A sold channel's fee promise that LND
keeps refusing to restore is an alert until a write takes, the fee is back within the
promise or the lease ends (its promise is no longer registered), and the fee area's status
says the cap could not be restored.

---

## 2. The fee engine (the heart) — `feeRecommend.ts`

For each channel the engine derives ONE target `fee_rate` in a fixed order, so signals
don't fight. The numbers below are what the autopilot (and the Fees tab) runs the engine
with by default: its settings where it passes them (`feeV2Overrides`: the policy's
min/neutral/max, protect, safety margin, ratchet steps, explore modifier, base fee, "Round
to" and min change, the run's change limit, the floor opt-in), the engine's own defaults
(`FEE_REC_DEFAULTS`) where it doesn't. The Strategy presets override some of them. (A test
compares this block with the code.)

**Config (defaults):**
```
minPpm            25     # cheapest a channel can go (lots of outbound)
neutralPpm        80     # the curve's level for a balanced channel (at its target ratio) — a ceiling there, not a
                         # target: raising it doesn't raise a channel routing at a lower fee (held, see below),
                         # and a channel that sells above it keeps its fee
maxPpm          1000     # priciest (fully drained)
protectPpm       350     # where a drained-but-still-wanted channel is ramped to
newChannelMinPpm  80     # floor for a new channel (its first 14 days, or until its third forward)
baseFeeMsat        0     # flat base fee to set (0 = volume-first)
stepPpm           10     # round to this — the policy's "Round to" (the engine's own default is 25)
minChangePpm      25     # leave a fee alone when it is this close to where the engine is heading
cooldownHours     72     # min time between raises on the same channel
flowWindowDays    14     # "recent" flow window
benchmarkWindowDays 30   # revenue/idle window
safetyMargin    1.15     # profit floor = refill cost basis × this
floorAboveMax  false     # a profit floor may lift a fee above maxPpm only with this opt-in
maxChangesPerRun   5     # at most N fee changes applied per run — the autopilot's setting (the engine's own default is 6)
```

**Aim and move.** For each channel the engine derives an **aim** (where the fee should end
up) and a **target** (this update's move toward it). Moves are small, bounded steps: a raise
moves at most **2 steps** (on every channel, routing or not; a learned elasticity can widen
the step to ×1.5 — **up to 3 steps** — never remove it) — except the **demand ramp** of a
drained channel that sold at the fee it charges now and the **drain ramp** of one that sells
itself empty (a quarter of the fee a move, see 8 below); a **price test** on a channel that
sells daily is one step, or a tenth of the fee; the protect and profit-floor ramps at most
**4 steps**; **every lowering** at most the **idle-ratchet's steps** — idle, routing, new or
drained. Only these move in one update, each for a reason of its own: a **step back** (to the
last fee that sold, see below), an idle channel
dropping to its **flow-won price** or to the **market price** into its peer (evidence, not a
guess — and nothing is at stake on a channel nobody routes through), a **pin** (the
operator's value), the **new-channel floor**, a broken **lease promise**, and a fee outside
the policy's **min/max** (a fee below the min goes to the min, and raises step on from
there — counted from the balanced level, a fee of 0 went "0 → 100" in one update).

**Raise only on a drain signal.** A channel that isn't below its target ratio, and that
nothing says drains (no drain velocity, no benchmark nudge for draining, not draining), is
**held at its fee**: the balance curve's balanced level never raises it. Routing at that fee,
it is the price that wins flow; routing nothing, a higher fee wins nothing back either. Only a
drained channel (the curve), drain velocity, the benchmark's draining nudge, a draining
channel's replacement cost, a floor or the policy's min raise a fee — and where a measured
elasticity below 1 has switched the drain reflex off, draining raises nothing either (its
reasons said "not raising toward the replacement cost" while the curve raised it). Raising **Neutral ppm**
therefore no longer lifts balanced channels by itself: it lowers balanced channels priced above it
that do not sell at their fee (one that sells keeps it, see the next paragraph), and it is
where the curve starts for drained and full channels (the policy hint says so). Before, a price that had
just won a channel two-way flow was raised straight back out of it (50 → 70 toward the
balanced level of 80) and lowered again after two quiet weeks — in a 120-day simulation with
demand that depends on the fee, such channels sat priced out 80–90 % of the time; now they
keep the price that routes (a test runs that loop on every preset, with and without a market).

**A fee that sells is kept** (review 2026-11-10, FEE-2). A channel that sold at least three
times at the fee it charges now, since that fee was set, and at least once in the last 7 days,
is not lowered toward a lower aim — the balance curve, a lower refill cost, the market, a
learned elasticity. The Why says so: `hold: it sells at N ppm (S sales …) — a fee that sells
is not lowered toward L ppm`. Before, a balanced channel that sold 200k sat a day at 300 ppm
was walked down to 90 ppm in seven moves (in a 60-day simulation it earned 1,202 sat; held at
its fee and tested upward, over 6,500). A write does not undo what the channel has shown: the
hold also stands where the channel sold three times in the last 7 days while its fee stood at
this one or higher (a fee just gone back to after a test above it), and where it sold once at
this fee and three times in the week. The same hold covers, for 7 days and whatever the
channel holds, a fee the autopilot raised to — what sells at it decides, and the step back
takes it back, not the curve — and the fee any step back went back to. It does not cover a
channel with **spare to sell**: one that holds more than its target (beyond the deadband) and
either takes in more than it sells (14-day inflow above its outflow by more than max(1 % of
capacity, 50k sat) and one of its sales — the first sale a step back's hours missed is no
inflow — and more in than out in the last 7 days — counted over the days the fee
stood at this one or lower: on the days of a price test it sold less because of the test),
or would need more than 90 days at its selling rate of the last 14 days to sell what it holds
above its target. There the fee comes down as before (`spare: it sells at N ppm, but holds
more than its target and … — the fee is not held for those sales`). The policy's range, a
pin, a lease promise and the no-flow rule lower a fee as ever. Where the forwarding history
could not be read whole, what sold is unknown and the hold cannot speak; the run says so
(`sales unknown: …`) and the fee is lowered as the other rules say.

**Price test** (decided 2026-11-10: a channel that sells keeps its fee, and a higher one is
tried in small steps). A channel that sells daily — at least 7 sales in the last 7 days,
three of them at the fee it charges now, and 6 in the last 72 h, which the fee has stood —
holds no more than its target, has no measured elasticity below 1 and no ordinary raise
ahead (its aim is at the fee, or nearer than the anti-churn threshold) is tried **one step
higher, or a tenth of its fee where that is more** (rounded down onto the grid, at most to
the max; never on a pinned or excluded channel): `price test: it sells at N ppm (S sales …,
W in the last 7 days) and holds no more than its target`. The 72 h are what the test is set
against, so the next test follows 72 h after the last at the earliest. Below seven sales a
week no test is made: two days without a sale are then the rule, not a sign.

A test is **judged once, 72 h after the raise**: what the channel earned in the test's first
72 h against the 72 h before it, at the fee before. Both stretches are over when they are
read, so the answer does not depend on the hour the autopilot runs in (judged on a running
average from 72 h on, the same test was kept or taken back by the hour). Less, and the fee
goes **back to the fee before the test** in one move (`step back: tried A→B ppm … and it
earned less in its first 72 h`); as much or more, and it is kept and the next test may
follow. A test nothing sells at for 48 h goes back by the step back below. It is not taken
back while the channel had nothing to sell or refused an HTLC for lack of balance since the
test.

One step of a tenth cannot be told from chance on three days' sales, and a test kept by
chance is the base of the next. So kept tests are **checked again as a climb**, against the
fee the climb began at: at the end of each of the climb's weeks (in force for 48 h), what
the channel earned in its last days — up to 14 — is set against as many days before the
climb. The hours of a test that was taken back since, or was not yet judged when the week
ended, are left out of both stretches (a climb from 300 to the 330 ppm buyers paid was taken
back whole for the two dead days of the try at 360). Less by more than one sale, and the fee
goes back to where the climb began, in one move (`step back: raised A→B ppm by price tests
since … and it earned less there, by more than one sale`); otherwise the line says what it
earned against what (`price test: at B ppm, up from A ppm … : kept`). What the fee
before the climb earned is read over the hours it stood before the climb, and, where a climb
from it — price tests, raises of the drain rules — was taken back to it before, over the hours
it stood before that climb as well (the climb's own hours left out).

A **raise the drain rules made** — the drain and demand ramps, the velocity nudge, the
balance curve under the target, the protect ramp, a 30-day drain's raise, the benchmark's
nudge for a draining top earner — is part of the climb it begins and is checked the same way,
at the end of its weeks, **once the drain is over**: the channel is inside its target band
again, no fast drain is measured, and the days the climb is set against were no drain either
— at what went out net a day in them at the fee before (the last day before the climb left
out: a burst that set the raise off is no drain the fee before allowed), the channel would not
be down to 10 % local within 21 days from where it is. Less by more than one sale, and it goes back
to the fee before it (`step back: raised A→B ppm by the drain rules … the drain is over, and it
earned less there`), remembered as a failed test; while the channel still drains it is kept,
and the line says so (`raised: at B ppm … less — kept while the channel drains`). Before, such
a raise was kept for good by the hold once the channel was balanced again: one buyer who took
400k from a balanced channel left its fee 20 % higher, and its other buyers paid a sixth
less. A raise toward a refill cost and the floors are not part of a climb: they end it. With Fee
automation off, a move applied with "Apply" is not held on trial either (nothing could take it
back).

A test that was taken back is not repeated for 7 days — 14, then 28 when tests fail in a row
at the same level (`price test: N ppm was tried and taken back … — no higher fee is tried
before <date>`). For as long, an ordinary raise stops below the price that failed as well
(`hold: N ppm was tried and taken back … — it earned less there; not raised to it before
<date> unless the channel drains`); the demand and drain ramps, the protect ramp and the
floors are not bound by it — a failed test must not hold a draining channel down.

What a test costs: where buyers pay up to a price and nothing above it, the fee is tried up
to that price and stays there; each try above it costs the two days without a sale until the
step back, and is made again after 7, 14 and 28 days. In a 60-day simulation with buyers who
pay up to 330 ppm, a channel starting at 300 earned about 3,400 sat (a fee fixed at 300:
3,600; at 330: 3,960); starting at 80 with buyers who pay up to 110, about 840 to 890 sat in
90 days (fixed at 80: 720; at 110: 990). At one sale a day no test is made.
There is no test downward: a channel that sells at its fee is not offered cheaper to see
whether it would sell more (in a simulation with buyers who buy less the more it costs, a
channel starting above its best price stays there — the price of this decision).

**A raise needs a sale** (review 2026-10-25). An ordinary raise — the curve, drain velocity,
the benchmark, the replacement cost, the demand ramp — waits until the channel sold at least
once at the fee it charges now, since that fee was set (by the fee-change log); the Why says
so ("hold: nothing sold at X ppm since it was set — not raised toward Y ppm before a sale").
The profit floor, a new channel's floor, the min/max range, pins and lease promises are not
held by it. The **protect ramp** is (review 2026-11-10, FEE-1): below Protect ppm a drained
channel is lifted only when it sold at the fee it charges now, or refused an HTLC for lack of
balance, since that fee was set — each step of the ramp anew (`protect: drained (N% local),
but nothing sold at X ppm since it was set — not ramped toward P ppm before a sale`). Before,
a channel one buyer had emptied at 30 ppm was ramped to 340 ppm in eight moves with nothing
left to sell, and what flowed back into it later met a price nobody had ever paid. A **sale** is a forward
out of at least 1,000 sat; forwards out of the channel within 60 s of the one before count
once — one payment's retries, and its shards even when they enter through different channels
(until the final review the 60 s were counted per incoming → outgoing pair, so three shards
through three channels were three sales) — for the demand and drain ramps' three sales and the refill
gate's proof alike. When the forwards couldn't be read completely, sales are unknown and the
ordinary raises go on as before. The hold names the aim as your max bounds it.

**Step back.** A fee the autopilot raised and then not sold at for 48 h, while the channel had
something to sell (local balance minus its 1 % reserve at least max(50k, 1 % of capacity))
and refused no HTLC for lack of balance since the fee was set (those are buyers at this
price), goes back in one move — paced like a lowering — to **the last fee that sold** (review
2026-11-10, FEE-1): the engine follows the autopilot's raises that ended at this fee back
through the fee-change log, to the highest price of that climb at which something sold, or,
where none of them sold, to the fee before the climb's first raise — and never below its
**proven level** (the highest fee of the last 14 days it sold at least 3 times at; see
Rebalancing): not at all when a level at or above the current fee sold three times. Before,
it went back one raise only: a ramp that went 80 → 350 ppm in 42 hours past buyers who paid
up to 150 stepped back to 340 and stayed above them for months. A **floor is where it
stops** (FEE-8): the policy's min, a new channel's protected fee, the profit floor of the
refills still in the channel — the step back lands on the highest of them, its Why names
which (“back to P ppm, its profit floor, what its refills cost”), and with no room below the
fee there is no step back (before, “step back … to 80 ppm” stood over a fee a floor kept).
The 48 h count from the raise, or from when the channel last got
sats to sell if that is later: the fee stage notes each run since when every channel has had
something to sell without a break (a channel drained in between starts again — before, its
raise was stepped back on the first run its liquidity came back; two looks further apart than
three run intervals, at least 6 h, start every clock again). A fee set by hand (`POST /fees/apply`
or a pin) is never stepped back; a move of the engine's own applied with **"Apply"** on the
Fees tab is the engine's (`engine: true` on its record) and is judged like any other — as
long as Fee automation runs: the step back and the judgements need the clocks its runs keep,
so with it off no price test is offered and a raise applied by hand is not taken back. Nor is
a raise stepped back whose earlier fee wasn't known (a manual apply
that couldn't read LND's fee is on record with an unknown "from" — it read as a raise from 0).
For 7 days after a step-back, the fee it stepped back from is not raised to again — a raise
stops on the grid step below it ("guard: stepped back from …"), the profit floor, a new
channel's floor, the min, pins and lease promises excepted; the protect ramp is bound by it
(below Protect ppm it goes no higher than that — the price nobody bought at is not ramped
back to under another name). The memory **grows** (FEE-11):
a step-back that ends no higher than the one before it is a repeat, and the fee is then not
raised back for 14 days, after the third in a row for 28 (a channel whose buyers paid up to
150 ppm went 140 → 160 → 140 every nine days for months). And each failed try **halves the
stretch** that is tried again: while the fee stands in the lower half between the fee it went
back to and the one that failed, a raise stops in the middle of the two. The drained-idle hold doesn't strand it there; a drained channel nobody
routes through shows that hold ("an idle channel is never raised") with its fee as the aim, and
no raise note ("small nudge up", "raising fee") stands beside a hold or a step-back.

**On the grid.** A step lands on the “Round to” grid (a raise rounds down onto it, a lowering
up — a 333 ppm step lands on 330 at a 10 ppm grid). A move that lands exactly stays exact — a floor, the min, a jump to the
flow-won or market price. **In demand** (the protect rule's "wanted") needs at least 50k sat of
refused HTLCs, not just their count. A channel younger than 30 days is never a close candidate
("idle since it opened N d ago", not "idle for 30 days"). A top earner, which the benchmark never
lowers, no longer shows an "idle test" it doesn't run.

**The threshold.** The anti-churn threshold (`max(minChangePpm, 20% of the fee)`) judges the
gap between the fee and the aim, not the size of one step — it used to veto the engine's own
steps (+20, −30, +40 at step 10 were all under it), freezing draining channels low and idle
ones high. The no-flow rule's own moves (a ratchet step, a jump to the flow-won or market
price) and any move from a fee outside the min/max range are not judged by it at all: they
are deliberate, bounded and paced already, and at the low fees small nodes charge it vetoed
them within 25 ppm of their destination ("dropping to 50 ppm" from 70, never applied; 1,010
ppm against a max of 1,004 stayed, 6 ppm "below threshold").

**A missing market reference never lowers a draining channel.** A report whose graph has no
reference for a channel's peer uses the last one seen, for up to **7 days** (and says "last seen
…"): a peer back from an outage still has the other nodes' channels into it disabled in the graph
for a while (LND re-enables them ~20 minutes after it returns, then gossip, then this node's graph
cache), so it drops under the 3 channels a reference needs — while our own channel to it is active
again within seconds. With no reference at all (a thin peer, a cold start, a graph that can't be
read) a draining channel is **held** where the balance curve would lower it: its refill cost is
unknown. Before, one such run lowered a channel priced at its refill cost 340 → 310 toward the
balanced level, and since every lowering restarts the 72 h raise wait, gaps every few days walked
it down to ~100 ppm for good.

**Why.** The first reason of a channel (the Why column, and the "why" of each change in the
run history and the fee-change log) is the rule that set its move: a floor, the no-flow rule,
a pin or a lease promise when one of them set it; otherwise the rule that set the aim — the
replacement cost (`replacement: …`, also when a channel priced above it is lowered toward it),
the market (`market: …`), a velocity or benchmark modifier, draining (`draining: …` — a channel
at or above its target ratio raised because it drains), an elasticity modifier, or the balance
curve itself (`balance: …`); for a write that only changes the base fee, the base fee. A line
that denies the move is never left beside it: a hold that a floor, the range, a pin or a lease
promise overrode, "never raised" or a no-flow lowering under a fee that goes up. Where a pin, an
exclusion or a lease promise sets the move, the engine's rules keep only their facts ("profit
floor: … = 1035 ppm", not "— ramping 80→120" beside a pin of 25), and a rule's claim of a
direction the fee doesn't take is cut the same way ("lowering toward 95 ppm" under a floor's
raise). A step guard ("a→b on the way to c") appears only where the step stops the move short of
its aim. A broken lease promise says what breaks it (the rate, or only the base fee).
Turned-away payments lead only when they are what kept the fee where it is (not lowered as
idle).

**Per-channel derivation order (`buildRecommendation`):**

1. **Metrics** — routed-out/in over 14d & 30d, revenue, net drain, channel age (from the
   channel-id block height), and the **refills still in the channel**: the refills of the last
   **30 days** that passed the profit gate (the autopilot's, and those run by hand from a
   recommended row on the Rebalancing tab — the gate goes with them, capping their payment at
   every size, and its value is booked as their hold; a refill run by hand without the gate
   chose its own price and sets none), each retired first in, first out as its sats route
   out (LND's lifetime "sent" counter of the channel, recorded before each refill). Only
   those sats set a **profit floor**: a refill
   holds the price the profit gate valued it at (never less than its cost × `safetyMargin`;
   refills recorded before that hold read as cost × `safetyMargin`) until its sats have routed
   out — 30 days at most, and **released under low flow** (a week after the refill, fewer than 3
   forwards out in 14 days at ≥ 40 % local). Capped at `maxPpm` unless the operator opted in.
   Plus two outside signals:
   - the **market** (public graph, nothing paid or sent): the capacity-weighted median fee
     other nodes charge to forward into the same peer, and the peer's own fee back to us — a
     refill costs at least both (**replacement cost**). The graph is read at most every 30
     minutes; an older read (up to 12 h) is served at once while a fresh one runs, so a slow
     read never drops the market from a report (it did on every other run: market-priced fees
     flapped 80→50→70→40…). Only a cold start waits for the graph: a page up to 15 s, the
     scheduled fee run up to 2 minutes. A read that never answers is given up after 10 minutes
     (the next caller starts a new one). A channel whose peer drops out of the graph's
     reference keeps its last one for 7 days (above);
   - **refused demand** (failed-HTLC telemetry, de-noised: probes ≥ 90% of a channel,
     retries of the same amount within 10 minutes and HTLCs over half the channel are
     counted apart). A channel with ≥ 3 de-noised refused HTLCs (possible demand) on ≥ 2 days
     in 14 days is **in demand**, even without a successful forward. The de-noising is a
     heuristic: these are refused HTLCs a refilled channel could have carried, not proven
     payments.

2. **Role → target ratio.** Each channel is classified from lifetime flow:
   `source` (mostly receives) → target localRatio 0.45; `sink` (mostly sends) → 0.55;
   `router`/`neutral` (balanced) → 0.50.

3. **Balance curve → base ppm.** Compare current localRatio to the target (deadband ±0.05):
   - within deadband → the balanced level: `neutralPpm`. On a channel that is **not
     winning flow at its own price** (no forward in the 14-day flow window, testing a lower
     fee, or well below the node's flow) the curve's balanced level is lowered to ~0.9 × the
     market into the peer when that is cheaper — never on a top earner, a channel whose
     velocity says draining, steady outbound demand or active and balanced, a draining
     channel or one with possible demand (a top earner routing 2.4M a month at 80 ppm was
     cut toward 27 ppm). Never raised — volume-first stays the default
   - more local than target (excess outbound) → interpolate **down toward `minPpm`**
   - drained below target → interpolate **up toward `maxPpm`**
   - the curve lowers a fee above its level; it raises one **only on a drained channel**
     (below its target ratio) — see "Raise only on a drain signal" above

4. **Velocity modifier** (from real recent demand):
   - draining fast (gross ≥0.2, net ≥0.1 of capacity in 14d) → ×1.1 (small nudge up)
   - steady outbound demand → ×1.05
   - idle **and** over-local → ×0.85 (**explore** a lower fee to attract flow; not when in demand,
     nor on a brand-new channel)

5. **Benchmark modifier** (only with ≥5 channels): compare this channel's flow to the node
   median. Outperforming + draining → ×1.05. **Top earners are never pushed cheaper** by
   this nudge, the explore test or the market (only the balance curve or a measured
   elasticity below 1 can lower one).
   Well below average + over-local → ×0.95 (test lower).

6. **Elasticity** (learned per channel — only from strong evidence): at least 4 measured fee
   changes on the channel that all point the same way, each with ≥ 10 forwards before and
   after, and a mean of at least two standard errors, shrunk toward the node-wide signal.
   Most small nodes have no such channel; the Fees tab says so. A modifier < 1 blocks the
   drain-reflex raise; > 1 widens the raise step (at most ×1.5) — it never removes the bound,
   and it raises only a fee a drain signal raises (a channel held at its price stays held).
   Changes are measured from the **fee-change log** (every applied change, kept a year), each
   over the interval until the next change on the channel, in msat, net of the rest of the
   node's move.

7. **Combine:** `combinedMod = clamp(velocity × benchmark × elasticity, 0.7, 1.5)`;
   `aim = baseCurve × combinedMod`. A **draining** channel (net outflow ≥ 10% of capacity
   in 30 days, ≥ 3 forwards) is aimed at least at its replacement cost × safetyMargin (≤
   maxPpm) — its outbound is not sold below what it costs to get back. Where raising has
   measurably cost flow (elasticity < 1) the replacement cost raises nothing: the channel is
   held at its current fee — not raised toward it, not sold cheaper either. Without any market
   reference (none this run, none remembered) a draining channel is held where the curve would
   lower it, and raised only by a higher aim.
   A channel that **sells itself empty** (review 2026-11-10, FEE-3) is priced for the balance
   it will have: where, at what it sells net a day at the fee it charges now, it is down to
   10 % local within 21 days, the aim is at least the curve's price for the balance it will
   have **in 7 days** at that rate (an empty channel's price where it would be empty by then)
   — `drain: it sells ~X a day net at N ppm — at that rate it is down to 10% local in ~D d —
   priced for the ~P% local it will have in 7 days: ~Y ppm`. The rate is the largest of: what
   sold since the fee was set (over 6 h at least) and the last 1, 3, 7 and 14 days where the
   fee has stood that long — sales at an older, lower fee say nothing about this one; each
   stretch counts with ≥ 3 forwards and ≥ 5 % of capacity net out (what came in is taken
   off), and none unless the last 14 days show 5 % net out too, and at least half of what the
   stretch says goes out in as many of them as it covers: a channel that routes both ways has
   days on which it only sells, and gets the sats back on others. Not where a measured elasticity below 1 says higher
   fees cost flow here. Such a channel counts as draining for the replacement cost as well.

8. **Bounded moves:** the target moves toward the aim by the steps above. **A drained channel
   nobody routes through is never raised** (it jumped to ~900 ppm in one update before), and
   lowered only by ratchet steps.
   - **Demand ramp** (2026-10-24): a **drained channel with buyers** — under 10 % local (the
     protect rule's "drained"), ≥ 3 forwards in 30 days, not refilled faster than it sells (14-day
     inflow at most max(1 % of capacity, 50k) above its outflow — a 2-sat inflow switched it off), no measured elasticity below 1 — that **sold at the fee it charges now**
     (three sales since that fee was set — a sale as above: at least 1,000 sat, one per 60 s burst
     out of the channel — by LightningMate's own stamp; the refill gate's proof, too) is raised by
     **a quarter of its fee per move** (rounded down onto the grid, at least the ordinary two
     steps), **at most every 6 h** (the operator's cooldown if longer — and the operator's own,
     shorter cadence while the move stays within a protect or profit-floor ramp's reach — a move
     that would cross such a floor stops on it first), never past its aim. Two steps every 72 h took a drained top earner (1 % local, 151 forwards a
     month) six weeks from 350 ppm to the ~640 a refill at the market's ~500 ppm route cost needs
     — selling every sat that came back below what it costs to replace. With buyers at each price
     the ramp goes 350 → 430 → 530 → 660 → 820 → 1000 in about a day; **each move waits for three
     sales at the price before it**, so where nobody buys at the new price it stops one step above
     the last price that sold (the ordinary steps go on; a detail line in the Why says the faster
     raise waits for a sale). One sale per level ramped a price-sensitive channel to 880 ppm on
     thin evidence and reset the count before a refill's proof could form (review 2). A channel with liquidity keeps the gentle steps. It leads the Why — the run history
     and the fee-change log keep the first line: `demand: drained (…% local) and sold N times at
     X ppm since it was set — raising a quarter of the fee per move (at least two steps), at most
     every 6 h: a→b on the way to c ppm`. (Moves 6 h apart are too close for the elasticity
     learner to measure; the sales each move needs are the ramp's check instead. A fee another
     tool changed carries no stamp: sales at the old fee then count — the refill gate stays safe,
     since it values at what was paid.)
   - **Drain ramp** (review 2026-11-10, FEE-3): a channel that still has liquidity and **sells
     itself empty** (7 above) is not left at two steps every 72 h either. With three sales at
     the fee it charges now it is raised like the demand ramp — **a quarter of its fee per
     move**, at most every 6 h, each move after three sales at the price before it, never past
     its aim, stopping on a protect or profit floor ahead first — and, where what a refill
     costs is known and above its fee, **a third of the way to that cost** per move where that
     is more (never more than doubling the fee). Raises were four to five times slower than
     lowerings: live, one buyer emptied a full 5M channel priced at 30 ppm in two evenings
     while a refill cost about 700 ppm — 157 sat for 4.3M sat; in a simulation a channel at
     80 % local whose buyers took 300k sat a day and paid up to 400 ppm sold 3.95M sat at 96
     ppm on average and reached 350 ppm empty. Its Why leads: `drain: it sells ~X a day net at
     N ppm — at that rate it is down to 10% local in ~D d (S sales …) — raising a quarter of
     the fee per move (at least two steps), at most every 6 h: a→b on the way to c ppm`. What
     no rule can price is one payment burst inside a run interval: a fee changes between runs.

9. **Floors:**
   - new channel (<14 days, <3 forwards) → at least `newChannelMinPpm` (three days were less
     than gossip and other nodes' pathfinding need to try a new channel at all: one was at its
     protected fee for 2.9 days and at the min a day later — review 2026-11-10, FEE-7)
   - profit floor (the refills still in the channel, see 1) → ramped toward it (4 steps a move)
   - **protect**: drained (<10% local) **but still in demand** (forwards, or refused HTLCs a
     refill could have carried — possible demand) → ramped toward `protectPpm` (4 steps a
     move, at the operator's cooldown) — each step once something sold at the fee it charges
     now, or an HTLC was refused for lack of balance since it was set (see “A raise needs a
     sale”), and below a step-back's memory no higher than that
   - The floors stay inside the policy's range (FEE-4): `protectPpm` and `newChannelMinPpm`
     are clamped into min..max — with Max ppm 200 and Protect ppm left at 350 a drained
     channel was ramped to 300, and a new channel was lifted to 80 over a max of 50 and then
     “brought down to it at once”. A Protect ppm above Max ppm is refused when the policy is
     saved, and one already stored is set to the max when the settings load (with a line
     saying so). Only the profit floor passes the max, with its opt-in.

10. **No-flow rule (core volume lever):** if the channel routed **0 forwards in 30 days**,
    has ≥10% local — or, drained, still at least max(50k sat, 1 % of capacity) to sell (review
    2026-11-10, FEE-1: under 10 % local an idle channel was never raised and never lowered
    either — 350k sat stayed at 340 ppm for good beside buyers who paid 150) — isn't new
    (14 days) and isn't refusing possible demand → **lower the fee**
    to win flow back (overrides the curve and floors, except new-channel protection):
    - with a **flow-won anchor** (the ppm at which routing last returned here, remembered
      per channel for 60 days): jump straight to that price — best evidence beats stepping;
    - else, with a **market reference** above which it sits: jump to ~0.9 × what others charge
      into the peer, on the "Round to" grid (a channel already there steps on below it —
      before, the jump to 36 rounded back to 40 every day and the channel never moved again);
    - otherwise the balance decides how far down, and how fast (FEE-7; before, every idle
      channel went to the min whatever it held — and the first buyer took half a channel for a
      third of its price, 2.45M sat at 25–40 ppm):
      - holding **more than its target** (beyond the deadband): ratchet down toward `minPpm`
        (`current − ratchetSteps×stepPpm` per step, paced once a day) — sats to spare, which a
        lower price may move;
      - **at its target or under it**, priced above the **balanced level** (Neutral ppm on the
        grid — the market-lowered one where the market is below it): the same ratchet, to the
        balanced level only;
      - **at its target**, at the balanced level or under it: one grid step **a week** toward
        the min (buyers who pay less than the balanced level must still be found; the first
        sale stops it within a step of their price);
      - **under its target**, at the balanced level or under it: held — what little it holds
        is not discounted (`hold: nothing routed here recently, and at N% local it holds less
        than its target — not lowered below the balanced level (D ppm)`), and an idle channel
        is not raised.
    A jump lands exactly on that price, a ratchet exactly one step lower (at most to the min,
    which it reaches exactly — rounding 25 to the 10-ppm grid stopped it at 30) — the balance
    curve or the explore price no longer cut an idle channel further in one move (1,500 → 900
    ppm at 20% local before). None of these is vetoed by the anti-churn threshold.
    The autopilot tracks each lowering episode and records the current fee as the new
    anchor the moment outbound flow returns. We never price-kill an idle channel.

11. **Clamp + round** to `stepPpm` (rounding never stretches a bounded move, never turns a
    move around and never moves a held fee; a fee at the policy's min or max, or at a floor —
    a new channel's protected fee, a protect or profit-floor ramp — lands on it exactly: on a
    25-ppm grid a new channel's 80 rounded to 75). A fee above the max is brought down to it in one move, one below the min up to
    the min (only to it — raises step on from there), and says so (`range: …`). Manual per-channel overrides win here: `exclude` =
    don't touch; `fixed` = the pinned ppm **exactly as set** — outside the policy range, the
    rounding, the threshold and the pacing — applied once, then held. (On upgrading to this,
    pins stored outside the policy's min/max — the old pin inputs saved a blank field as 0 —
    were rewritten once to the fee the engine had given them, with an alert.)

12. **Base fee → `baseFeeMsat` (0).** Managed now (previously just preserved at ~1 sat).

13. **Lease promise (D7)** — last: a channel sold through Magma or LSPS1 stays within the
    caps its order locked, for the lease (a Magma lease a day of blocks longer, since Amboss
    counts it from its own confirmation — and for as long as Amboss's listing still reports
    the lease running, whatever that count says) — over every rule above, pins included.

14. **Apply guards (decide *whether* to apply, never the target):**
    - skip when the fee is within the threshold of the aim, **unless** the base fee also needs
      changing, it is a pin, a lease promise is broken, or the move is the no-flow rule's own
      (a ratchet step or a jump) or starts from a fee outside the min/max range
    - **asymmetric pacing**: a **raise** waits `max(user cooldown, 72h)` since the last apply
      (a ramp — protect or profit floor — steps at the user cooldown; the demand ramp and the
      drain ramp at `max(user cooldown, 6h)`, at the user cooldown while within a floor ramp's
      reach; a price test like any raise, 72 h); a
      **lowering** steps at most once per `max(24h, user cooldown)` — the idle channel's step
      below the balanced level once per 7 days. A channel with no prior change applies
      immediately either way.
    - a channel whose last update failed (LND refused it, or it couldn't be sent) waits
      **6 hours** before it is tried again — a broken lease promise excepted (the wait is saved:
      a restart no longer cuts it short);
    - at most `maxChangesPerRun` actual applies: broken lease promises first, then pins, then
      the biggest moves.

Applying uses LND `updateRoutingFees`, preserving `cltv_delta` and HTLC limits (a legacy
max HTLC above the channel's max pending amount is left out — LND would refuse the whole
update). A channel LND refuses (it answers with per-channel failures, not an error) is a
failure: no cooldown, no outcome — and no retry for 6 hours (the Fees tab shows it held; the
same refusal again is not repeated in the run history). A broken lease promise is retried at
every check. Every write — the autopilot's, a lease promise kept, a manual Apply or pin —
goes through the same books: the cooldown, the run history (with the reason) and the
fee-change log. The lease promises are checked every 10 minutes even with
every switch off. Each write is booked — and saved — as LND answers it, before the next is sent:
a restart in the middle of a batch keeps the cooldowns and fee-log records of the writes already
made. "LND refused" is said only of an update LND refused; one skipped (its policy unreadable)
or never answered reads "not applied".

Three things about the books (review 2026-11-10). A channel's **inbound fee** — a discount
set by hand, the Fees tab says where one would pay — is sent along with every fee and max
HTLC write exactly as it was read (FEE-9): whether LND keeps the inbound fee of a write that
does not name it depends on its version (0.21 keeps it, checked on regtest; early 0.18
releases are said to reset it). A fee **found different from the books** — set in another
tool, or written by the app right before a crash, between LND's answer and the save — is
booked once, as a change by hand (`found at this fee — set outside the app, or by it right
before a restart`): the cooldown and the sales “since it was set” count from then (FEE-10;
before, the engine counted sales made at the old fee and raised again at once). And a write
that **leaves the rate as it is** — the base fee alone, after the setting changed — is no
new price: it no longer restarts the raise wait or the count of sales at the fee (FEE-12).

The **Advertise routable size** pass: under 1,024 sat to forward, a channel advertises its
min HTLC (1,024 it couldn't carry drew failed small payments that read as demand). An update LND
says it took but the channel doesn't advertise is recorded once and left alone for 6 h (live: the
same write every 30 minutes for 19 h). A channel set to **exclude** is left alone by this pass
too (review 2026-11-10, FEE-5: with the pass on, an excluded channel got eight policy updates
in three days; a pinned channel is still managed — the pin is its fee, not its size). And a
channel's advertised size changes **at most once in 6 h** (FEE-6: a near-empty channel in use
flipped between two sizes with every run, a channel update each) — except a change of two
buckets or more, which is made at once: down to a quarter or less, always, since senders
would fail on what it advertises, and up to four times as much or more once in the 6 h, since a
channel just refilled would advertise a tiny size for six hours (one that swings by that much
with every run is not rewritten with every run: 48 updates a day before). Within the 6 h the size can be off by one
bucket.

---

## 3. Strategy — one goal, cascaded (`AutopilotPanel.tsx`)

At the top of the Autopilot tab are three presets. Picking one shows **exactly what it
changes** — the switches it turns on that move capital (channel opens from on-chain funds,
refills paid in routing fees, a bigger refill budget) first — and, once confirmed, **writes the
whole fee curve AND which of the routing sub-autopilots run**, so the parts pull the same way.
The detailed per-subtab controls below still override anything afterwards. **Pause all
automation** switches every automation off at once and remembers which were on — a run
already in progress asks the live switch before each fee write, refill payment, channel open,
max-HTLC update, offer write and Magma order accept — after every read that step waits for, so
nothing is awaited between the check and the step — and starts nothing new after the pause (the
step under way finishes; Magma orders already taken on are carried to their end; an accept whose
hold invoice was made but not yet sent is withdrawn, its coins freed). A paused order lane
neither accepts nor turns down a new order — before deciding, and again after its capital
check and its dial of the buyer, it asks the switch: the order waits for the operator on
Market → Orders. (D6's immediate reject of an order the node can't serve is a running lane's. A
reject the operator clicked is theirs, not the lane's: one Amboss didn't confirm is sent again,
paused or not.)
After a crash, an accept is completed only if it may have gone out (it is marked on disk
before it is sent); the lane's own accept that never left is withdrawn when selling is off by
then (one the operator clicked is theirs and goes out). An accept whose mark can't be saved
(a full disk) is never sent: its invoice is released and the order is decided again — a running
lane rejects it when its approval deadline is close, never leaving it to time out; a paused lane
leaves it to the operator — as either lane does an order whose accept the operator clicked.
**Resume** switches those
back on — Selling excepted, whose switch-on is its own decision with the selling
check in front of you (D9). LSP mode (Settings) is no switch of the autopilot's: the pause leaves
it on — it keeps answering wallet orders and opening their channels — and the pause dialog, the
paused banner and the Overview say so while it is on.

Each area keeps its **last decision and why** (D16): acted, nothing to do, waiting (a
cooldown, the hours, the budget, the fee rate, the funds, a switch turned off during the run),
deferred (capital left for Magma), blocked (no Amboss key or one Amboss rejects, write mode
off, selling on with no offer and auto-pricing off, or — for the channel and Magma areas — a
write macaroon without `peers:read`, which every open needs to check its peer's connection:
named as such, checked at start, and a new Magma order turned down for it says so) or error —
and "not run yet" for an area switched on that hasn't decided anything — shown at the top of
its sub-tab and, compactly, on the Overview, and logged with its time when it changes. The same standing decision again only
counts up ("waiting ×48 since 08:00"); each action is a decision of its own. Waits and
deferrals are never failed runs; a stage — or a fee write, an own open, an offer write — that
fails the same way run after run is one line of history, but every one of those runs reports it
(its counts, the Overview, "Run once now"), and a fee LND refuses again keeps LND's reason.

Each preset sets the full fee curve, its **behaviour** (protect floor, profit-floor margin,
how fast idle channels get cheaper, how aggressive the explore-lower cut is) AND the
**rebalance economics** (strictness + per-run cap + daily fee budget). Base fee is 0 on all.

| Preset | min/neutral/max | protect | safety­Margin | ratchet steps | explore mod | Rebalance: econRatio / max·run / daily budget | Channels | Magma |
|---|---|---|---|---|---|---|---|---|
| **Max routing** | 25 / 60 / 1000 | 250 | 1.05 | 4 | 0.75 | 0.9 / 4 / 25k sat (refills rarely pass at these fees) | on | untouched |
| **Balanced** (default) | 25 / 80 / 1000 | 350 | 1.15 | 3 | 0.85 | 0.8 / 2 / 10k sat | on | untouched |
| **Max profit** | 80 / 150 / 1500 | 600 | 1.35 | 1 | 0.90 | 0.6 / 1 / 5k sat | untouched | untouched |

Rationale: "Max routing" = cheapest fees + zero base + fast ratchet down → win the most
forwards (*lots of forwards for few sats*). Its rebalance settings are the loosest, but the
profit check decides: a refill must net at least 100 sat on a move of at most a quarter of the
channel, which at fees this low needs a route far cheaper than the channel earns — so on a
small low-fee node refills rarely run, and the preset says so instead of promising "loose
rebalancing". "Max profit" = higher fees, slow ratchet, a strict profit check → fewer,
richer forwards.
"Balanced" competes for flow at sensible fees. ("untouched" = the preset leaves that switch as
it is; Max profit no longer switches channel opens off.)

**No preset touches Magma selling** (no `sell*` key at all). Selling stays off unless the
operator switches **Selling** on themselves — after a confirmation that shows a
live check of whether the node can realistically sell (offers like its would-be offer, by
Amboss fee tier and seller score, and how often they fill). Earlier versions had "Balanced"
switch selling on and "Max profit" switch channel opens *off* to "lease idle capital rather
than route it" — for nodes whose offers, measured on Amboss's public book, never sold.

**How the cascade reaches the engine:** the preset writes the persisted config's `policy`
object (`minPpm`, `neutralPpm`, `maxPpm`, `baseFeeMsat`, `protectPpm`, `safetyMargin`,
`noFlowRatchetSteps`, `exploreLowerModifier`), the `rebalancePolicy.econRatio` +
`maxRebalancesPerRun` + `rebalanceDailyBudgetSats`, and the on/off flags. On each run,
`feeV2Overrides()` maps `policy` → the fee engine's config, and `rebalanceRecOverrides()`
maps every rebalance setting onto the recommender's gate — `econRatio` → `profitShare`,
`minNetProfitSats`, `maxPaybackDays`, `maxAmountSats` (so the strategy loosens or tightens
which rebalances *qualify*, not just the execution budget). Still fixed across
strategies (not yet cascaded): `cooldownHours`, the flow windows, and the exact
velocity/benchmark tiers and the no-flow *trigger* (0 forwards / 30d) — only its *speed*
is cascaded.

---

## 4. The other three sub-autopilots

**Rebalancing** (`runRebalances`): a recommender finds drained channels worth refilling and
only returns moves where the route cost is justified by what the refilled sats earn (a
`route_found_profitable` gate). The gate values the moved sats at the lowest of what the
channel earned, charges and is heading to — and of the fee the fee engine charges **after**
the refill (asked of the engine itself, `feeAfterRefill`); the engine then **holds** that
price while the refilled sats are in the channel (see the profit floor above), so the gate's
estimate and the engine agree. (It is the engine that holds it: the rows and the confirm dialog
promise the hold — with its limits — only while fee automation is on.) What it **earned** is the 30-day average at the fees it had —
which lags a higher price that sells for a month — **or its proven level** (2026-10-25): the highest fee of the last 14 days at which it
sold at least 3 times (the fee-change log's levels and the forwards; a sale as above), valued at
what those sales paid — never above its fee now, its target or its aim. A channel the demand ramp
moves on to ~989 ppm is refilled at the proven 820 in the same run; before, each ramp move
reset the proof, and the refill waited for three sales at the new fee. Never a price nobody
paid: a first version valued one refill at the untested fee, and the refill's hold kept that
fee for up to 30 days where nobody bought (in a 60-day simulation it cut the channel's net from
1,365 to 203 sat where demand stopped at 500 ppm). A refill valued at a proven price is **at most
10× the sats that sold at it** (at least the 50k minimum): three 1k forwards don't carry a 443k
refill whose hold then keeps the fee there. A pin or a floor's lift counts like any fee — only
once it sold three times at it (three sales, as above); until then the row says what would
count. And only a **recent** proof: a level whose last sale is more than 7 days old values a
refill at no more than what the channel earned in 30 days (the row says so). The **demand** the gate counts — the earnings cap and the refill's
size — is, for a **drained** channel (under 10 % local) not refilling itself (14-day inflow at
most max(1 % of capacity, 50k) above its outflow), the larger of its 14-day outflow and half its 30-day one (net drain likewise); every
other channel counts its 14 days. A drained channel can't route out, and its last 14 days
understated it: a top earner at 1 % local had sold 2.4M in 30 days but 0.23M in 14, and every
refill was sized and valued on the 0.23M. "What it would take" asks for the demand counted. A move passes only if its route costs at most `econRatio` of
the expected earnings, it nets at least `minNetProfitSats` and pays back within
`maxPaybackDays` — and **the payment's max fee is that same limit at every size it tries**
(the smaller fallbacks too), never more than is left of today's budget. The sizes, per
source: the planned one; when that fails the check, the **largest size whose fee at the
route's probed cost stays within the limit** (rounded down to 10k, at least the 50k
minimum) — a 1.25M refill turned down only by the payback limit is planned at 1.12M rather
than dropped, since its half no longer nets the minimum; then its half and its quarter. A
**manual** refill does the same when it runs, with the plan's route cost, if the planned size
no longer fits its cap — the budget left has shrunk since the plan, or the confirm dialog
promised less. The autopilot's own run doesn't get there that way: a move whose estimated fee
is more than the budget left waits for the daily budget before any size is tried (below).
Sources: never a channel younger than 14 days, a private one, one sold through Magma or LSPS1
in its lease (or one whose Magma lease Amboss still lists as running — a sale the order
journal never recorded too; the listing is kept on disk, and the close list and a close ask
Amboss for it again only when the copy is over an hour old), one with any net outflow in 14 days, a top earner or the node's single best
earner; each gives at most its balance above its own target share + 5 %, and the moves
planned from it shrink what it can give the next target. Up to three sources are tried per
target, the next one when no route pays from the one before; a failed source backs off for
that target only (cooldown × 2^fails, at most ×8). A refill of ≥ 500k may split over 3 paths
(the payment carries the invoice's feature bits — without them LND never splits).
Never a target: a channel bought on Magma while its lease runs (its low local balance is what
was bought), nor one younger than 30 days that hasn't routed yet. The per-target fail counts
from before the per-pair back-off (0.7.x), never added to since, are dropped on upgrade.
Runs at most `maxRebalancesPerRun` (the best moves that fit the budget left — a pricey best
move no longer blocks a cheaper one; a move whose estimated fee no longer fits what is left
after the run's earlier payments waits for the daily budget rather than going out with a
starved fee cap), respects a per-target cooldown and an hour window in
**UTC**. **The daily fee budget** covers the autopilot's and manual refills alike and is read
from the rebalance log (payments still in flight count at their maximum fee): a restart or a
crash can't reset it, and it starts afresh at 00:00 UTC. Every payment attempt is written to
disk **before** it is sent, so a restart or a crash mid-payment (an update's shutdown waits
37 s, a payment up to 150 s) loses nothing: the restarted process counts it at its maximum
fee, leaves its two channels alone, and books it — fee, hold, sent counter, on the day it was
sent — once LND says how it ended. An attempt whose wait broke off without LND saying how it
ended counts as still in flight (no smaller size or other source is tried meanwhile). Each
attempt's pathfinding gets the time left less 10 s, in whole seconds (at most 45 s), and none
starts with under 20 s left: LND's own failure then arrives inside the wait — before, it came
just after the attempt was booked "in flight", and the next size never got a real try. A payment
LND refuses outright is failed at once, with LND's reason — once LND says twice, 2 s apart,
that it has none by that id (a call cut off in transport may still be creating it at LND); the
question has its own 20 s deadline, and anything but those two answers counts as in flight. LND failing
a refill before anything was sent (its first reads) fails that refill only: its cooldown is
given back, and the run goes on with the next. After the
shutdown signal no new attempt starts — no smaller size, no other source: only the payment
already under way is awaited, and the refill counts as skipped, not failed. A manual
refill is capped at what is left and refused when nothing is; it never pays beside the
autopilot's rebalance stage (one refill at a time), nor into or out of a channel whose earlier
payment may still land (the tab shows that payment instead of a Run button), but no longer
holds up the rest of a run (fees, lease promises, channel opens, Magma). Run from a
recommended row, it carries the profit gate and its price is held like an autopilot refill's;
a row planned at a higher fee than the target charges now (a tab left open) is valued at the
fee now, its cost per sat capped to match. Moves the budget or the per-run limit leave for
later are **not** failed runs: they go into the rebalance decision ("last decision" on the
tab), never into the run history. A drained channel the gate turns down says what a refill would need
(earnings per sat at the demand-sized refill, outflow, net drain — and when that price is above
the max ppm, that no fee it may charge pays for it).

A refill goes out of its source and nowhere else: the route question shuts the first hop to
every other peer out (LND 0.21 ignores the single outgoing channel QueryRoutes still takes),
and the payment is made by the invoice's request with the source as `outgoing_chan_ids` (the
single field of SendPaymentV2 is ignored too). On regtest, asked the old way, a refill went out
over the target peer's own other channel and straight back, and LND then shunned that peer's
last hop for every refill. A refill that arrives on the peer's other channel is booked there,
cooldown included (`server/e2e/refill.ts`).

**Channels** (`runChannels`, `openPlan.ts`): opens one channel per cooldown to the best
peer suggestion it can really open, when on-chain funds exceed the reserve. It walks down the
ranked suggestions and skips, with the reason, a peer of low usefulness, one LN+ operators
rate poorly, one this node closed a channel with in the last 90 days, one on the operator's
"never auto" list, one without an address to dial (unless connected), and one still backing
off after a refusal (1 day, then 7, then 30). While LND doesn't say its block height or its
closed channels, no peer is opened to automatically (a close within 90 days can't be ruled
out). The size meets what the peer takes: its LN+
minimum, or the minimum (or maximum) its refusal named — auto size rises to a minimum up to
a third of the node's capital, a fixed size never does — and auto size shrinks to what can be
spent, rounded down to 100k, never below 1M nor the peer's minimum (the payback is judged at
that size). The reserve is what an open leaves on chain; LND's own anchor reserve (10k per
anchor channel, up to 100k) wins when it is larger, and the open's fee comes on top. It dials every address the peer
advertises (.onion first on a Tor-only node), at most three peers a run and no new one after
two minutes. The funding pays LND's economy rate (a 72-block target) — up to the next whole
sat/vB only once the estimate is more than a tenth above one: 1.012 → 1, 1.4 → 2 — never above the
operator's maximum (`channelMaxFeeRate`, 20 sat/vB by default), and only when the open and a
later close pay back within 12 months of what a channel of that size earns on this node
(capacity-weighted yield of channels older than ~30 days, trusted only with at least 10 forwards
or 1,000 sat earned through them in 30 days; with less — or no such channel — only the maximum
rate applies, and the note says the payback was not checked). The channel starts at the fee
engine's protected new-channel fee (manual opens too; the Open form says which).
A failure on this node's own side — LND's wallet not synced, too few confirmed coins, the
anchor reserve, or no connection to any peer at all (Tor or the internet down; then nobody is
dialed) — holds no peer back: the stage stops, says why, and the next run tries again. A
peer's own refusal during the negotiation ("received funding error from …", whatever it says,
or LND's "reservation timed out") comes before any broadcast: the peer backs off and the next
suggestion is tried in the same run. An open that ends unclearly (its funding may be out)
stops the run and starts the cooldown as an open does. Each open is on record (peer, amount,
time) before LND gets it — saved, or the open is not sent: a restart that finds one LND never
answered counts it as unclear, so the cooldown runs from it. One this process still waits on
(its stage given up while LND funds it) is left alone: its answer books it, and no other open
goes out before. The on-chain mutex held for over 10 minutes is an alert naming
its holder. Waits and deferrals are the stage's decision note, never failed runs; a refusal is one line
of history, not one per run. Every open takes the shared on-chain mutex and capital ledger.
**Capital gate (`leaveForMagma`, D10):** with selling on, the coins Magma can
list — spendable, within the deploy cap's headroom — are held for it when ALL of these hold:
Amboss accepts the key and an offer of this node is listed (enabled); the selling check says
better than "not realistic" (offers like this node's sell at least about once a year); and
the lease income this capital can expect (how often offers like it fill — capped, once its own
offer has been listed 60 days, by its own record: (fills + 1) / (years listed + ½) — × what one
fill nets at the clearing price of comparable leases, after on-chain costs and the service
fee, over the capital it could list) beats what a sat of this node's channels at least ~30
days (4,320 blocks) old earned, capacity-weighted (until 2026-10-25 the median channel: 0 on
a node where most route nothing). The rest stays free for routing opens; the open waits
("deferred") only when what is left can't fund the smallest open, and every note says how
much is held. Each comparison is kept: when Amboss's public book can't be read (right after
a restart: it is cached in memory) — or the comparison fails — the last one stands for a day,
said so, holding no more than the offer can list now; past that, or with none on record, what
the listed offer can list is held, on the safe side (an order it accepts must find its coins). Without routing history or clearing data, nothing is held — a node can always open
its first channels. This is the one place capital allocation is unified across routing vs leasing.
**Close list** (`rankCloseCandidates`): a channel under 30 days old — or whose age can't be
told — is never a candidate. One that routed is protected for what it earns only when its 60-day
earnings (its own fees plus those of the forwards it brought in) on its local balance reach a
quarter of what a sat of this node's channels earns over the same 60 days, and at least 25
ppm/yr; below that it is listed ("Earned … in 60d … under a quarter of what this node's
channels earn"). "Significant unique reach" protects only with at least five 2-hop nodes no
other peer reaches. A forwarding history read cut short (LND had more than was read — the
newest are missing) or not read lists no channel as idle, losing or earning too little: only a
peer away for days does then. Where freed capital could go names only opens the channel
autopilot would make (its peer rules and LN+), ranked at most every 30 minutes — LN+ is not
asked on every load. The Magma hint never offers more than the deploy cap leaves after
running leases and accepted orders (the offer upkeep's headroom). Parallel channels to an existing peer (adding capacity where a
channel earns) are not planned yet.

**Magma** — two parts. The **order lane** (every 45 s, its own busy flag, never the main
run's lock) accepts orders with a hold invoice, opens the channel, reports it, settles once
Amboss confirms it and has paid the invoice, and rejects at once what it can't serve — every step recorded in a
per-order journal first. A buyer it can't reach is not among those: the order stays open, the
lane dials again every 3 minutes, says why it can't reach the buyer (LND's own answer for each
address), and rejects without another dial once the approval deadline is 4 minutes off, the longest
a dial and the gap to the next pass can take. A dial waits for LND's answer, 90 s in all: onions first
(the quick way through a Tor proxy), each address with its share of the time, tried again if time
is left. Once a pass has spent that long on dials the other orders wait for the next, the buyers not
yet dialed first, so silent buyers don't hold up a reachable one (a buyer never dialed with its deadline
close still gets its try). A paid order's dial is bound by its deadline too: a first try goes out up to
it, a failed open is tried again only while it is more than 10 minutes off, and then the payment
is released rather than a channel opened. That deadline is Amboss's `timeout` only where it lies after
the payment was held — the approval deadline left in that field is not one (review 2026-11-10: a buyer
who paid after it was refunded at once), nor is a `timeout` still equal to the one the order showed
while it awaited approval (kept on its record as `approvalDeadline`): a buyer who paid before that
deadline, then offline or with fees high, was refunded 10 minutes before it instead of waited for. The hard limit is the held payment itself: a channel is opened
only while the payment can still be held 60 blocks more (36 for the channel to confirm and Amboss to
validate it, 24 before the payment is released). Until then — about 38 hours of the invoice's 288
blocks, before: 30 minutes — a buyer offline after paying is dialed again every 3 minutes and missing
coins are waited for; an open LND refuses for a reason that may pass (the buyer's node has another
channel pending) is asked again every 3 minutes too, not on every pass. Then the buyer is refunded and
the order's record says what was tried last
("… — last tried: …", or what it waited for: "… — it waited for lower fees until then: …"). Should LND
name no height for a held payment, those hours cannot be counted and the window stays 30 minutes. An order
paid outside a HODL invoice (an older version's plain invoice, settled on payment) holds nothing that
could go back: it is tried for 38 hours after the payment was found. It waits for lower on-chain fees
(or a fee estimate) like a held order, but its wait ends in the open, not in a refund: 6 hours before
those 38 run out (or before a deadline of Amboss's) the channel is opened whatever the fee, with the
6 hours left to reach a buyer who is offline just then — the one open allowed to cost more than the
order brings, as its payment cannot go back: an alert then names what it cost against what it brought. If its channel cannot be
opened in that time (or before a deadline of Amboss's), the order ends with the buyer's payment kept:
an alert says so until it is dismissed, and "Open channel" on Market → Orders takes the order up again
for as long as Amboss lists it as waiting for its channel — otherwise the buyer is owed the payment,
which the operator settles with them. **A sold channel's open states its fee rate**: LND's regular estimate (6 blocks,
a whole rate), the one the accept floor is priced with — not the economy rate of the autopilot's own
opens, and not capped by `channelMaxFeeRate`, for the buyer has paid and waits. The lane opens while
the funding transaction (175 vB) at that rate costs no more than the order's fee after the service fee;
above that, or while LND gives no estimate, the paid order waits (checked every pass, said once on its
record, the lane's status "1 paid order waits for lower on-chain fees", or "… waits for an on-chain
fee estimate"), for as long as the held
payment allows an open — then the buyer is refunded. **No open costs more than the order brings**
(decided 2026-11-12): "Open channel" on Market → Orders opens under the same limit — dearer, or with no
estimate, the click is refused with both numbers and the order goes on waiting. The one exception is an
order an older version accepted with a plain invoice, whose payment settled here and cannot go back:
it is opened after its wait whatever the fee, and an alert says what the open cost against what the
order brought (with no estimate at all LND picks the rate, and the alert can't name the cost). Every paid order refunded with no channel opened raises an alert (48 h, or until
dismissed): Amboss may count it against the seller. Before, the open named no rate: LND picked one
hours after the accept floor was checked, and nothing looked at it. **Amboss pays after the channel is
confirmed** (seen on the first live sale, 2026-11-11: the buyer had paid Amboss, and the order went
from the accept straight to "waiting for the channel" with this node's invoice unpaid). For an order
this node accepted the lane therefore opens the channel while its invoice is still open and unpaid —
it does not wait for a held payment (before, it did: every sale stood still until its deadline). What
that risks is the open's on-chain fee (166 sat on that order): if Amboss never paid, the channel and
its coins stay this node's. Where the buyer pays this node's invoice first (the way Amboss's
documentation describes, the order "waiting for the buyer's payment"), nothing is opened before the
payment is held, as ever. **Never a second channel for one order**: before every open — the lane's or
a click on "Open channel" — the order is read from Amboss again (it must still wait for its channel,
with no funding transaction named), the order's record must show no open under way, and LND must show
no channel of this node to the buyer with the order's size that was not there at the accept (the
buyer's channels of that moment are kept on the order's record). One that is there is taken as the
order's ("a channel to the buyer was opened outside LightningMate — taken as this order's") — also
one opened and reported by hand that has no confirmation yet. A channel to the buyer of another size
is not the order's (Amboss takes only the order's size): the record says so once, and the order gets
its own. For an order whose record does not list the buyer's channels at the accept (one from before
that was kept, or one accepted outside LightningMate), a same-size channel still being opened is
neither taken nor opened beside until it is confirmed and its height shows whether it is new. Where
Amboss names a funding transaction LND does not show as this order's, nothing is opened beside it, an
alert says so, and at the order's last moment to open the order is ended like any other. **One channel is never two orders'**:
when the buyer has another open order here, that order is read from Amboss first, and a channel
Amboss names for it is left to it — while such an order cannot be read, nothing is taken or opened
for this one. The time such an unpaid order has runs to
Amboss's `timeout` for the channel (seen live: 48 hours after the invoice was made; never past the
invoice's own end, and with no usable `timeout` — none, not a date, or earlier than the invoice — 48
hours after the invoice), less 6 hours for the channel to get its confirmations (half the time there
is, when Amboss gives less than 12 hours): its last moment to open. Up to then a failed open is tried
again and high on-chain fees are waited out as above; in its last 6 hours the open is priced at LND's
3-block estimate — or, where that is dearer than the order brings, at the highest rate the order pays
for, if that is no less than LND's usual estimate. Still dearer, or with no estimate at all, at the
last moment to open, the order is ended instead of opened — the invoice cancelled, the coins free, an
alert with both numbers (or that the cost could not be estimated). Amboss refunds the buyer when it ends the order at its own deadline, and may
count it against the seller: the Magma API's seller `reject` is documented for orders awaiting
approval, and LightningMate never sends it for one Amboss approved — so ending the order earlier would
refund nobody sooner. An order the lane leaves to the operator says by when to open it, and an alert
names it: "Open channel" opens it up to its last moment to open, under the same ceiling; after that the
lane ends it (as a click would, saying why) and the refund is told. An order Amboss shows accepted that no accept sent from LightningMate (and not
refused) carried is not opened by the lane — Amboss may hold another invoice for it — and waits for
"Open channel"; nor is one Amboss shows accepted after it answered this node's accept with an error
(that accept may not be the one Amboss took). **Amboss's word alone is never income**: an order
Amboss reports confirmed is settled, booked and charged the service fee only when this node's own
invoice holds at least the order's fee and a channel is on the order's record that LND shows (open,
still opening, or closed since). An order with no channel on its record takes the one Amboss names —
when LND shows it as this node's channel to the buyer, also among the closed ones, and no other sale
has it. Otherwise the payment stays held and unclaimed and the record says why (Amboss names no
channel, LND shows none, or the channel is another sale's); a pass in which LND does not answer
settles nothing. An invoice
still unpaid at that moment is the normal case, not an error: the order waits for Amboss's payment
("channel confirmed — waiting for Amboss's payment", said once on its record) until the invoice runs
out, 49 hours after it was made; a payment that arrives is settled as ever. After 6 hours of waiting an
alert names the order (not one whose payment is here and whose claim is held up: its record says why).
Only when the invoice has expired, or was cancelled, unpaid does the order end here, unbooked — its
coins free again, or, where a channel was opened for it, kept as a completed sale that is not booked,
so the lease's promises go on binding that channel, with an alert for a week or until it is dismissed
(for a while the order ended after one hour, its invoice cancelled before Amboss could pay it). A
payment that was here and never claimed, let go by LND near its expiry, ends the order with that said. Where Amboss turns
the channel down after the open or ends the order, the invoice is cancelled, the channel stays open
and an alert says so: it is this node's to keep or close. While an order is pending no offer's window or listing moves up. Before 0.8.7 a dial gave up after 1.5 s, so nearly every
buyer not already connected was turned down within seconds
(a 2,436 sat order on 2026-10-31, 5.3 s into its two-hour window). It decides on new orders only while selling is on (a
paused lane neither accepts nor rejects one); an order it accepted itself it carries to its
end either way, and with selling on it also opens the channel of an order accepted by hand
(Market → Orders says who opens a paid order's channel). An order it finds paid with no record here
and no invoice of ours for it in LND (accepted on amboss.tech or with another tool while LightningMate
was off) is the one paid order it opens no channel for: LightningMate opens none by itself for a payment
it can't see — the order waits for "Open channel", and is never booked as a sale. A decision made by hand wins over the
lane, for an order the lane isn't working on at that moment: a click on Accept or Reject that
finds the order — Amboss shows it as this node's, awaiting approval, or the lane has it on record
as awaiting approval (then even a click that can't read it) — makes the order the operator's,
whatever becomes of the click, and their latest click stands — also against an accept already sent
that Amboss never confirmed (the record says "accepting"), the operator's or the lane's: a Reject of
such an order is sent while Amboss still shows it awaiting approval, and again on every pass, the
accept no more; the accept's invoice is released once Amboss confirms the reject. Only an accept
Amboss turns out to have applied stands against it: the order is accepted then, and its record says
so ("Amboss had applied the accept before your reject reached it — the order is accepted"). An
accept that never went out, cut short by a stop, still refuses a Reject ("Not rejected: an accept
of this order was under way when LightningMate stopped — the order lane completes or withdraws it
on its next pass."). An accept Amboss doesn't confirm is handled by what Amboss answered. No
answer, or an outage (a timeout, a 5xx): the same accept is sent again on the next pass, whatever
the selling switch says, for it may have reached Amboss. An error about the accept itself (a
business rule, a 4xx, a query Amboss rejects): a refusal, once the next read shows the order still
awaiting approval — the invoice is released, and after 3 refusals the lane rejects its own order,
as it does after 3 answers of `success: false`. With the approval deadline 2 minutes off, the lane
rejects its own order whose accept is still unconfirmed rather than let it time out on the seller
— the reject first, the invoice released only once Amboss confirms it, so an accept that did reach
Amboss is never left without its invoice; an order the operator accepted is never turned down that
way, and a paused lane rejects nothing; past the deadline no reject is sent. Before, every such accept was sent again every 45 s
until the order timed out, its size reserved, and a Reject of it was refused. What Amboss answered
to each accept, reject and funding report, and each read of the order that changed, is kept on the
order's record in `magma-orders.json` (`amboss`, the last 24, never the key or an invoice). A click
that finds neither (Amboss or LND not answering) records nothing:
with selling on, the lane may decide that order before the operator tries again. A
click that arrives while the lane is already deciding or acting on that same order — its capital
check, its dial of the buyer (up to about a minute and a half over Tor), its own accept or
reject, or the resend of an earlier reject of the operator's — waits for that step to finish
(one action per order at a time, the lane's or a click's); if the order was accepted or rejected
meanwhile, the click says so — done, if that is what it asked for ("Order is already accepted.",
"Order is already rejected."); refused, if it asked for the other ("Order is
WAITING_FOR_BUYER_PAYMENT — only orders awaiting approval can be rejected", "Order is
SELLER_REJECTED, not awaiting approval") — and the order stays as the lane left it (a reject of
the lane's own raises its "turned down" alert). An order the operator rejects is their
decision — no "turned down" alert — and a reject Amboss didn't confirm (an error, a refusal) is
sent again on every pass, whatever the selling switch says and even while Amboss won't show the
order (a reject needs only its id), until Amboss confirms it or the order ends; the lane never
accepts that order. An order whose accept by hand didn't go through stays theirs to
decide ("your accept didn't go through"): the lane neither accepts it nor turns it down — not
for its caps, which don't bind a manual pick, nor near its deadline. The lane carrying out the
operator's decision (their reject sent again, their accept completed) is recorded as theirs (the
run history's `via: "manual"`): the Overview's "Last change by the autopilot" leaves it out. The
**offer upkeep** (`runSell`, in the main run, only with selling on) keeps each offer
fundable (cut,
disabled while its smallest channel can't be funded, listed again once it can — its terms,
price and the size that can be funded, written and read back before the listing), gives it the
standard 4,320-block lease and the
routing-fee promise (with auto-size), and prices it per `sellPricingMode` (with
auto-price): `fast` = the 25th percentile of what buyers actually paid, `balanced` = their
median, `premium` = their 75th percentile, `auto` = between the 25th and 75th percentile,
starting in the middle and stepping up after each sale (it never steps down on its own, but
follows the market when what buyers pay moves) — never below the profit floor. The base
fee is the one comparable offers charge (their median; 0 sat is a base too), the offer's own
while it is within max(50 sat, 20 %) of it. Beyond that it follows **at once when far off**
(the offer's base under half the market's or over twice it — the 0 that 0.8.0 left among
them), **else once the market's base has held at its level for 1.5 h** (a level that moves
beyond the tolerance starts the clock afresh, so a median one listing moves back and forth is
never followed), and **never sooner than 6 h after its last base move** (the autopilot stamps
each verified one). **Within a day of a base move it follows only a level that has held for 12 h**,
however far off (0 excepted): the median of a few offers jumps between two levels, and 284 ↔ 852 sat
counted as "far off" both ways, moving the live offer's base every 6–9 h for days. The clock also starts afresh when the offer's base moves by hand. Market →
Sell shows a pending move beside the base fee ("→ 284 at 17:14") and says why in its reasons.
(Until 2026-10-25 every move waited a day: the live offer kept its 0 for 24 h.) A base that
moves keeps the offer's price at the representative size √(min·max) — the rate makes up
the rest, so smaller orders pay more or less with it — and a lower base never goes on where
the offer's smallest order would then pay less than opening and closing its channel costs at
today's fee rate (the order lane's accept floor). (0.8.0's writes had left the live offer at
0 sat while nearly every offer charged one.) Each offer
is priced for the lease it carries after the write: the standard one with auto-size, else
the one it keeps — a longer lease buyers use (60, 90, 180 days) is priced as such, and a
price for a shorter lease than the offer promises is never applied to it. With every
offer-automation switch off, capital safety is all the autopilot does to an offer (its
lease and routing-fee promise stay as they are). An offer the operator created or edited
by hand is theirs: the autopilot changes none of its price or lease — capital safety still
cuts its max channel and total to what can be funded (and gives them back once there is
room); enabling or disabling it by hand decides only whether it is listed. Switching selling on lists the offers
that were disabled at that moment — its switch-off disables them — as LightningMate's last
offer sync showed them, those still disabled at the first offer read after the switch (with
no sync kept yet, every offer disabled at that read), each once it has a price and its
smallest channel can be funded, whoever owns its terms. Its terms go on first, read back:
the size that can be funded, and — where the autopilot sets its terms, with auto-pricing on —
the engine's current price for it, never an older one: without one that run (no market
report) it waits and is listed by a later run; with a lease the engine's price doesn't fit
(auto-size off, a lease buyers don't use) it waits for the operator, and an alert says to
set its price or lease, or turn on auto-size. An offer whose terms are the operator's, or
any with auto-pricing off, is listed at its own price, and the record says so. A write
Amboss doesn't keep leaves it off. Capital safety's relist, and the relist of an offer taken
off the market for being free, go by the same rule. Not listed: an offer
that was listed at the switch, or unknown to that sync, and is disabled at the read
(disabled after the switch); one disabled by hand after the switch; one kept off with "keep
disabled" on Market → Sell. The listing done — by the switch-on, or seen listed by a run —
nothing is left to relist: a later disable on amboss.tech sticks (one listed and disabled
again there between two runs, never seen listed, can't be told apart and is listed). If
selling goes off, or all automation is paused, while such a listing is on its way, the
offer is taken off the market again. A new offer is listed automatically only where the
selling check is better than "not realistic". Optional auto-relist, and optional auto-close
at a lease's end: the sale's own channel by its funding outpoint (txid and vout), never one a
running lease is listed on, kept open when under a quarter of it is on our side (the rest is
inbound worth keeping) or it routes well — over 30 days it earned, on the coins a
close would free, at least 5,000 ppm a year and what a sat of this node's month-old channels earns
(the node's own average alone, ~340 ppm/yr live, let 56 sat a month keep a 2M channel off the market;
the 5,000 is a fixed bar, not what this node's capital would earn sold again — a node that sells
readily earns more on a new lease)
— and kept when that can't be told (the forwarding history not read in full, no channel list):
never closed on a guess — and the close asked for at LND's economy rate, not while that is above the
maximum on-chain fee rate (`channelMaxFeeRate`), never without an estimate (a buyer's node that insists
on more ends that round; LND then finishes the close at its own estimate, which can be above the maximum —
said once on the order's record, and the close not asked again for a day). Right before each close it asks
again whether auto-close was switched off, all automation paused, or the stage given up. Each reason a
channel is kept is one line in the order's history (not one per run as its figures move). A 1% service fee applies to completed sales.

**When a lease is over.** Amboss's status (`CHANNEL_MONITORING_FINISHED`) is not enough: the
channel is closed only once this node's own count agrees — the funding block, the order's lease and
a day (144 blocks) have passed, the count every by-hand close is held to. Before, the status alone
closed it, so a status set early would have closed a channel inside its lease. The lease's length is
the order's on record here, else Amboss's; with none on record, or the node's block height unread,
the channel is kept. **Auto-close does not need selling on**: a lease that ends after "Liquidity
provision" was switched off is closed all the same (before, nothing was closed until selling was on
again); nothing is closed while all automation is paused. **The close is cooperative, always**: while
the buyer's node is offline none is asked for (tried again when it is back; a force close stays the
operator's to decide). A close the buyer's node refuses for its fee ("fee proposal exceeds max fee")
is under way in LND all the same and may finish at LND's own estimate, above the maximum: the order's
history says so once, and the close is asked again only if the channel is still open a day later.

**How much is listed (0.8.7).** With auto-size and auto-relist, a node's one offer lists what the
capital cap (`sellMaxDeploySats`) and the wallet allow, and takes orders up to the max channel size.
Before, it listed only its largest order: a 10M cap listed 5M, and 4.6M spendable with a 2M window
listed 2M. Listed capital goes with sales (≤ 5M: 2 of 33 offers sold; 5–50M: 4 of 10, review
2026-10-17 — a correlation). What the wallet limits moves in steps of 500,000 sat, a step counting
once it is cleared by 50,000 sat, and the window's max stays that far under the limit, so the
wallet's small moves don't rewrite the offer; a shortage cuts to the step below, never under the
largest order it takes. The page's "Everything free" sets the cap to the top of its range, so the
listing follows what is free on chain after the reserve, at every run. With auto-relist off what a sale took stays out, and with several offers
they share the capital as they are set. A size floor the mempool raised stays up for 6 h (the engine
prices the window that really stands), so fees hovering around a step don't move it all day. The
Magma decision says why an offer was written.

**Never an order below cost (review 2026-10-25).** The order lane turns down an order that
pays less than opening and closing its channel costs on chain at today's fee rate (its
accept floor, `saleAcceptFloorSats`); the offer upkeep checks every listed offer against
the same number, at the price it is written with. With auto-size, and terms that are the
autopilot's, the min channel goes up to the smallest order that pays for its channel (and at
least the engine's own minimum); when not even the largest order the offer can fund does,
the offer is taken off the market ("below cost at today's on-chain fee rate") and listed
again — its terms written and checked first — once fees are lower by a margin (its order has
to pay 12 % over the cost — or the cost plus the minimum profit where that is more: held against the bare cost both ways, a fee estimate moving a few
percent took the offer off the market and listed it again run after run), or once there is
capital for an order that pays for its channel. While LND's fee estimate fails, the floor is the last one it
gave (kept across restarts) — never the minimum relay fee's; past 6 h the lane says so with each
order it turns down, and an offer taken off the market below cost is listed again only on a
real estimate. An offer listed for free gets its price back judged the same way, at that
price. With no sale history to price from, a price follows listed offers a quarter at a time,
one step every 6 hours — also when the offer is taken off the market and listed again in
between, and when Amboss applied a step without answering. An offer the autopilot created
that Amboss's list does not show yet is not created a second time (it is waited for up to
6 hours). An offer whose window is the
operator's (or with auto-size off) keeps it: an alert and Market → Sell say from which size
its orders are turned down. A listed offer under its profit floor is raised before anything
else (its floor rounded up), whatever the market or the routing comparison says. While an
order waits for approval — or is taken on and not yet booked as a sale — nothing is
topped up or given back, and the offers share what can be sold. The deploy cap's share is
Amboss's listing of sold capital plus the journal's own sales funded since; when the listing
fails, the last good one (under an hour old) stands. A sold channel counts with its size while its
lease runs, and after the lease with what is still on this node's side of it, until it is closed
(before, it stopped counting at the lease's end with its coins still in it, and the next channel
was sold on top — over a few terms more than the cap sat in once-sold channels); where the cap is
the limit, the refusal's reason and the offer's note say how much of it such channels hold. A spend outside the main run — a channel
opened by hand, an on-chain send, an LSPS1 sale's channel — has the offers' capital checked
within seconds — no price or lease move, but the same capital and cost checks: it cuts what
can't be funded, can raise the min channel to the smallest order that pays for its channel and
take an offer off the market below cost. It takes the offers' own lock (the main run's magma
stage takes it too, so the two never overlap) within a 5-minute deadline, and never holds up a
scheduled run. A magma stage given up at its deadline writes nothing when its call answers
late. The lane bills an order's fee
parts (`fees.fixed + fees.variable`, when `fees.seller` reads 0) only when they are an
offer's price for the order's size to within a sat; any other amount is left to the operator,
and an alert names the order and its deadline. An auto-sized offer whose min goes up is priced
for the window it gets, in the same run (not for the old one, corrected a run later).
An Accept by hand below the floor needs a second yes. A sold channel opens with a routing fee
of its own (a new channel's, never above the lease's promise) and its order's tag
(`magma:<id>`); a sale whose channel was opened elsewhere takes its outpoint from Amboss and
LND, so its promise binds it. A service fee that can't be paid is tried for 30 days, about
daily after the first, before it is given up with an alert.

---

## 5. Config model (`AutopilotConfig`)

```
enabled, intervalMinutes, cooldownMinutes, maxChangesPerRun, feeFloorAboveMax
policy: { minPpm, neutralPpm, maxPpm, baseFeeMsat, protectPpm, safetyMargin,
  noFlowRatchetSteps, exploreLowerModifier, step, minChangePpm }
rebalanceEnabled, rebalancePolicy{econRatio, minNetProfitSats, maxPaybackDays,
  maxAmountSats}, maxRebalancesPerRun, rebalanceCooldownMinutes,
  rebalanceHourStart, rebalanceHourEnd (UTC), rebalanceDailyBudgetSats (null = no limit)
channelEnabled, channelReserveSats, channelSizeSats, channelCooldownMinutes, channelMaxFeeRate
sellEnabled, sellMaxDeploySats, sellReserveSats, sellMaxChannelSats,
  sellAutoClose, sellAutoRelist, sellAutoReprice, sellAutoSize, sellPricingMode
maxHtlcEnabled
```

Every numeric setting has bounds (`GET /api/autopilot` publishes them); a blank or
out-of-range value is refused with the field named, never turned into 0 (D17).

`maxChangesPerRun` and `maxRebalancesPerRun` at 0 mean none: no fee change is written, no
refill runs — and the area's decision says so ("Max … / run is 0 — …; raise it"), never
"waits for the next run". The rebalance hours are UTC; equal hours mean any time, and a start
after the end wraps past midnight (22 → 6). A window with no hour in it — 24 → 0, hour 24
being the next day's 0 — is refused, and one stored that way becomes any time on load, with
auto-rebalance switched off and an alert saying why. Switching the channel autopilot or
auto-rebalance on asks first, saying what it spends.

The Strategy presets write: `enabled`, `rebalanceEnabled` and (except Max profit)
`channelEnabled`, the `policy` curve and behaviour, and the rebalance economics
(`rebalancePolicy.econRatio`, `maxRebalancesPerRun`, `rebalanceDailyBudgetSats`). They never
write any `sell*` key.

---

## 6. Assessment — does this make sense, and where could it be better?

**What is sound:**
- One coherent goal beats per-subtab strategies that can contradict each other (e.g. "max
  profit fees" + "max volume rebalance" = pay to refill channels you then price out).
- Shifting the whole fee curve (min + neutral) plus zeroing the base fee is the right
  primary lever for forward count.
- The engine already resists the known failure mode (never slam a channel up — every move
  is a bounded step; never price-kill an idle one; learn elasticity only from strong
  evidence; price draining channels against what replacing their outbound costs).

**Open questions / candidate improvements (for the reviewing AI):**

1. ~~The Strategy only shifts the fee baseline + on/off.~~ **DONE** — presets now also set
   `protectPpm`, `safetyMargin`, `noFlowRatchetSteps` and `exploreLowerModifier` per goal.

2. ~~Rebalance economics aren't strategy-linked.~~ **DONE** — presets set `econRatio`,
   `maxRebalancesPerRun` and a new `rebalanceDailyBudgetSats` (daily rebalance-fee cap).

3. ~~**The three presets conflate two axes:** *where to earn* (route vs lease) and *how
   aggressive on price* (volume vs margin).~~ **RESOLVED** — presets decide only the routing
   side; leasing is a separate, opt-in decision behind the live selling check (D9/D10).

4. ~~`minPpm` 10 on Max routing is near-zero.~~ **DONE** — Max routing now floors at 25 ppm
   (10 is left for a possible future "experimental / ultra-volume" mode).

5. **No closed-loop auto-tuning above the presets.** The engine can learn per-channel
   elasticity — only from strong evidence (most nodes: none) — but the chosen strategy is static. Would an "auto" strategy that hill-climbs
   the node-wide revenue (or forward-count) target be worth it, or too unpredictable for a
   set-and-forget product? Note: over-automation previously caused an outage, so stability
   and explainability matter.

6. ~~Oscillation / hysteresis.~~ **DONE** — lowers pace at 1/day, raises wait ≥72h (the demand
   ramp of a drained channel that sold at its fee: ≥6h, a quarter of the fee a move), and the
   engine now remembers each channel's "flow-won price" (the ppm at which routing returned
   after a no-flow lowering, kept 60 days) and jumps straight there on the next episode
   instead of re-exploring from scratch.

7. **Base fee is globally 0.** Are there channel types (e.g. very large or premium peers)
   where a small base fee is worth keeping? Should base fee be strategy- or per-channel-set?

The goal is maximum sustainable yield, but with an explicit preference stated by the
operator: **more forwards for low fees is better than no forwards.** The "Max routing"
preset encodes that. The question is whether the cascade should reach deeper than the fee
baseline into the behavioral parameters and the other autopilots.
```
