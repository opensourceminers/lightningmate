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
3. **Channels** — open a channel to a well-scored peer if on-chain funds allow.
4. **Magma** — keep our offer fundable and well-formed, reprice/relist it if asked, optionally
   auto-close finished leases. (Orders themselves are fulfilled by a separate 45-second order
   lane, never by this loop.) Off by default: selling is opt-in (Liquidity provision).

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
the Liquidity provision switch-on kicks is not lost either. A manual fee write that finds
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
                         # target: raising it doesn't raise a channel routing at a lower fee (held, see below)
maxPpm          1000     # priciest (fully drained)
protectPpm       350     # where a drained-but-still-wanted channel is ramped to
newChannelMinPpm  80     # floor for brand-new channels (first 3 days)
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
drained channel that sold at the fee it charges now (a quarter of the fee a move, see 8
below); the protect and profit-floor ramps at most **4 steps**; **every lowering** at most the
**idle-ratchet's steps** — idle, routing, new or drained. Only these move in one update, each for a reason of its own: an idle channel
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
therefore no longer lifts balanced channels by itself: it lowers balanced channels priced above it, and it is
where the curve starts for drained and full channels (the policy hint says so). Before, a price that had
just won a channel two-way flow was raised straight back out of it (50 → 70 toward the
balanced level of 80) and lowered again after two quiet weeks — in a 120-day simulation with
demand that depends on the fee, such channels sat priced out 80–90 % of the time; now they
keep the price that routes (a test runs that loop on every preset, with and without a market).

**A raise needs a sale** (review 2026-10-25). An ordinary raise — the curve, drain velocity,
the benchmark, the replacement cost, the demand ramp — waits until the channel sold at least
once at the fee it charges now, since that fee was set (by the fee-change log); the Why says
so ("hold: nothing sold at X ppm since it was set — not raised toward Y ppm before a sale").
Floors, the min/max range, pins and lease promises are not held by it. A **sale** is a forward
out of at least 1,000 sat; the same incoming → outgoing pair within 60 s counts once (one
payment's retries and shards) — for the demand ramp's three sales and the refill gate's proof
alike. When the forwards couldn't be read completely, sales are unknown and the
ordinary raises go on as before.

**Step back.** A fee raised and then not sold at for 48 h, while the channel has something to
sell (local balance minus its 1 % reserve at least max(50k, 1 % of capacity)), goes back in
one move — paced like a lowering — to its **proven level** (the highest fee of the last 14 days
it sold at least 3 times at; see Rebalancing) or else to its fee before that raise. The
drained-idle hold doesn't strand it there.

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

8. **Bounded moves:** the target moves toward the aim by the steps above. **A drained channel
   nobody routes through is never raised** (it jumped to ~900 ppm in one update before), and
   lowered only by ratchet steps.
   - **Demand ramp** (2026-10-24): a **drained channel with buyers** — under 10 % local (the
     protect rule's "drained"), ≥ 3 forwards in 30 days, not refilled faster than it sells (14-day
     inflow at most max(1 % of capacity, 50k) above its outflow — a 2-sat inflow switched it off), no measured elasticity below 1 — that **sold at the fee it charges now**
     (three forwards out since that fee was set, by LightningMate's own stamp — the refill gate's
     proof, too) is raised by
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

9. **Floors:**
   - new channel (<3 days, <3 forwards) → at least `newChannelMinPpm`
   - profit floor (the refills still in the channel, see 1) → ramped toward it (4 steps a move)
   - **protect**: drained (<10% local) **but still in demand** (forwards, or refused HTLCs a
     refill could have carried — possible demand) → ramped toward `protectPpm` (4 steps a
     move, at the operator's cooldown)

10. **No-flow rule (core volume lever):** if the channel routed **0 forwards in 30 days**,
    has ≥10% local, isn't brand-new and isn't refusing possible demand → **lower the fee**
    to win flow back (overrides the curve and floors, except new-channel protection):
    - with a **flow-won anchor** (the ppm at which routing last returned here, remembered
      per channel for 60 days): jump straight to that price — best evidence beats stepping;
    - else, with a **market reference** above which it sits: jump to ~0.9 × what others charge
      into the peer, on the "Round to" grid (a channel already there steps on below it —
      before, the jump to 36 rounded back to 40 every day and the channel never moved again);
    - otherwise: ratchet down toward `minPpm` (`current − ratchetSteps×stepPpm` per step,
      paced once a day).
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
      (a ramp — protect or profit floor — steps at the user cooldown; the demand ramp at
      `max(user cooldown, 6h)`, at the user cooldown while within a floor ramp's reach); a
      **lowering** steps at most once per `max(24h, user cooldown)`. A channel with no prior change applies
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

The **Advertise routable size** pass: under 1,024 sat to forward, a channel advertises its
min HTLC (1,024 it couldn't carry drew failed small payments that read as demand). An update LND
says it took but the channel doesn't advertise is recorded once and left alone for 6 h (live: the
same write every 30 minutes for 19 h).

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
back on — Liquidity provision excepted, whose switch-on is its own decision with the selling
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
operator switches **Liquidity provision** on themselves — after a confirmation that shows a
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
once three forwards were paid at it; until then the row says what would count. The **demand** the gate counts — the earnings cap and the refill's
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
journal never recorded too), one with any net outflow in 14 days, a top earner or the node's single best
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
LND refuses outright (it has none by that id) is failed at once, with LND's reason. LND failing
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
two minutes. The funding pays LND's economy rate (a 72-block target), never above the
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
time) before LND gets it: a restart that finds one LND never answered counts it as unclear,
so the cooldown runs from it. The on-chain mutex held for over 10 minutes is an alert naming
its holder. Waits and deferrals are the stage's decision note, never failed runs; a refusal is one line
of history, not one per run. Every open takes the shared on-chain mutex and capital ledger.
**Capital gate (`leaveForMagma`, D10):** with Liquidity provision on, the coins Magma can
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
a restart: it is cached in memory) the last one stands for a day, said so; past that nothing
is held. Without routing history or clearing data, nothing is held — a node can always open
its first channels. This is the one place capital allocation is unified across routing vs leasing.
**Close list** (`rankCloseCandidates`): a channel under 30 days old — or whose age can't be
told — is never a candidate. One that routed is protected for what it earns only when its 60-day
earnings (its own fees plus those of the forwards it brought in) on its local balance reach a
quarter of what a sat of this node's channels earns over the same 60 days, and at least 25
ppm/yr; below that it is listed ("Earned … in 60d … under a quarter of what this node's
channels earn"). "Significant unique reach" protects only with at least five 2-hop nodes no
other peer reaches. Where freed capital could go names only opens the channel autopilot would
make (its peer rules and LN+). Parallel channels to an existing peer (adding capacity where a
channel earns) are not planned yet.

**Magma** — two parts. The **order lane** (every 45 s, its own busy flag, never the main
run's lock) accepts orders with a hold invoice, opens the channel, reports it, settles once
Amboss confirms it and rejects at once what it can't serve — every step recorded in a
per-order journal first. It decides on new orders only while Liquidity provision is on (a
paused lane neither accepts nor rejects one); an order it accepted itself it carries to its
end either way, and with selling on it also opens the channel of an order accepted by hand
(Market → Orders says who opens a paid order's channel). A decision made by hand wins over the
lane, for an order the lane isn't working on at that moment: a click on Accept or Reject that
finds the order — Amboss shows it as this node's, awaiting approval, or the lane has it on record
as awaiting approval (then even a click that can't read it) — makes the order the operator's,
whatever becomes of the click, and their latest click stands — except for an accept already sent
whose answer was lost (the record says "accepting"), the operator's or the lane's: an accept that
may have reached Amboss is completed first, whatever the selling switch says, and a Reject
meanwhile is refused ("Not rejected: the earlier accept of this order was already sent and is
being confirmed with Amboss, so it can't be withdrawn."), though Amboss may still show the order
awaiting approval. A click that finds neither (Amboss or LND not answering) records nothing:
with Liquidity provision on, the lane may decide that order before the operator tries again. A
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
**offer upkeep** (`runSell`, in the main run, only with Liquidity provision on) keeps each offer
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
each verified one). The clock also starts afresh when the offer's base moves by hand. Market →
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
room); enabling or disabling it by hand decides only whether it is listed. Switching Liquidity provision on lists the offers
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
inbound worth keeping) or it earns at least what a sat of this node's month-old channels earns,
and closed at LND's economy rate — never above the maximum on-chain fee rate
(`channelMaxFeeRate`), never without an estimate. A 1% service fee applies to completed sales.

**Never an order below cost (review 2026-10-25).** The order lane turns down an order that
pays less than opening and closing its channel costs on chain at today's fee rate (its
accept floor, `saleAcceptFloorSats`); the offer upkeep checks every listed offer against
the same number, at the price it is written with. With auto-size, and terms that are the
autopilot's, the min channel goes up to the smallest order that pays for its channel (and at
least the engine's own minimum); when not even the largest order the offer can fund does,
the offer is taken off the market ("below cost at today's on-chain fee rate") and listed
again — its terms written and checked first — once fees drop. An offer whose window is the
operator's (or with auto-size off) keeps it: an alert and Market → Sell say from which size
its orders are turned down. A listed offer under its profit floor is raised before anything
else (its floor rounded up), whatever the market or the routing comparison says. While an
order waits for approval — or is accepted and not yet on Amboss's listing — nothing is
topped up or given back, and the offers share what can be sold. The deploy cap's share is
Amboss's listing of sold capital plus the journal's own sales funded since; when the listing
fails, the last good one (under an hour old) stands. A spend outside the main run — a channel
opened by hand, an on-chain send, an LSPS1 sale's channel — has the offers' capital checked
within seconds (capital only: no price, size or lease move). The lane bills an order's fee
parts (`fees.fixed + fees.variable`, when `fees.seller` reads 0) only when they are an
offer's price for the order's size to within a sat; any other amount is left to the operator.
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
