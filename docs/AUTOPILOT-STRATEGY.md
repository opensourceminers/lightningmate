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
4. **Magma** — fulfil sell orders, reprice/relist our offer, optionally auto-close.

Each sub-autopilot has its own on/off switch and detailed settings. Every action is a
**dry-run recommendation** first (shown in the UI), and only applied when its autopilot is
on and the change passes safety guards.

On top of the four sub-autopilots sits **Strategy** — three one-click presets that
configure everything coherently (Section 3).

---

## 2. The fee engine (the heart) — `feeRecommend.ts`

For each channel the engine derives ONE target `fee_rate` in a fixed order, so signals
don't fight. All numbers below are the current defaults (`FEE_REC_DEFAULTS`), some of which
the Strategy overrides.

**Config (defaults):**
```
minPpm            25     # cheapest a channel can go (lots of outbound)
neutralPpm        80     # fee for a balanced channel (at its target ratio)
maxPpm          1000     # priciest (fully drained)
protectPpm       350     # floor for a drained-but-still-wanted channel
newChannelMinPpm  80     # floor for brand-new channels (first 3 days)
baseFeeMsat        0     # flat base fee to set (0 = volume-first)
stepPpm           25     # round targets to this
minChangePpm      25     # ignore changes smaller than this (anti-churn)
cooldownHours     72     # min time between raises on the same channel
flowWindowDays    14     # "recent" flow window
benchmarkWindowDays 30   # revenue/idle window
safetyMargin    1.15     # profit floor = rebalance-cost-basis × this
maxChangesPerRun   6     # at most N fee changes applied per run
```

**Per-channel derivation order (`buildRecommendation`):**

1. **Metrics** — routed-out/in over 14d & 30d, revenue, net drain, channel age (from the
   channel-id block height), and a **cost basis** = average ppm we've paid to rebalance
   *into* this channel. `profitFloorPpm = costBasis × 1.15` (never route below refill cost).

2. **Role → target ratio.** Each channel is classified from lifetime flow:
   `source` (mostly receives) → target localRatio 0.45; `sink` (mostly sends) → 0.55;
   `router`/`neutral` (balanced) → 0.50.

3. **Balance curve → base ppm.** Compare current localRatio to the target (deadband ±0.05):
   - within deadband → `neutralPpm`
   - more local than target (excess outbound) → interpolate **down toward `minPpm`**
   - drained below target → interpolate **up toward `maxPpm`**
   (Idea: cheap when we have outbound to give away; expensive when we're running dry.)

4. **Velocity modifier** (from real recent demand):
   - draining fast (gross ≥0.2, net ≥0.1 of capacity in 14d) → ×1.1 (small nudge up)
   - steady outbound demand → ×1.05
   - idle **and** over-local → ×0.85 (**explore** a lower fee to attract flow)

5. **Benchmark modifier** (only with ≥5 channels): compare this channel's flow to the node
   median. Outperforming + draining → ×1.05. **Top earners are never pushed cheaper.**
   Well below average + over-local → ×0.95 (test lower).

6. **Elasticity gate** (learned per channel): if raising the fee here measurably *lost*
   revenue before, the learned modifier is <1 and blocks the drain-reflex raise. If raising
   *lifted* revenue, it's >1 and allows a higher price. Neutral history = 1.0 = no effect.

7. **Combine:** `combinedMod = clamp(velocity × benchmark × elasticity, 0.7, 1.5)`;
   `target = baseCurve × combinedMod`.

8. **Gentle-raise cap:** if the channel is actively routing, the rise is capped to
   `current + 2×stepPpm` per run — **never slam a working channel up** (this was the failure
   that once killed all routing: fees spiked and priced the node out of the market).

9. **Hard floors (always win, may exceed maxPpm):**
   - new channel (<3 days, <3 forwards) → at least `newChannelMinPpm`
   - profit floor → at least `costBasis × 1.15`
   - **protect**: drained (<10% local) **but still in demand** → bump to `protectPpm` (350)
     to slow the bleed (only if it's still getting forwards).

10. **No-flow rule (core volume lever):** if the channel routed **0 forwards in 30 days**,
    has ≥10% local, and isn't brand-new → **ratchet the fee down** toward `minPpm`
    (`current − 3×stepPpm` per run). Overrides the curve and floors (except new-channel).
    The opposite of a drain reflex: we never price-kill an idle channel — we make it cheaper
    until it wins flow back.

11. **Clamp + round** to `stepPpm`. Manual per-channel overrides (`exclude` = don't touch;
    `fixed` = pin a ppm) win here.

12. **Base fee → `baseFeeMsat` (0).** Managed now (previously just preserved at ~1 sat).

13. **Apply guards (decide *whether* to apply, never the target):**
    - skip if `|target − current| < minChangePpm` **unless** the base fee also needs changing
    - **asymmetric cooldown**: a **raise** must wait out `cooldownHours` (72h) since the last
      apply; a **lowering** applies immediately (win flow back fast)
    - at most `maxChangesPerRun` (6) actual applies, biggest moves first.

Applying uses LND `updateRoutingFees`, preserving `cltv_delta` and HTLC limits.

---

## 3. Strategy — one goal, cascaded (`AutopilotPanel.tsx`)

At the top of the Autopilot tab are three one-click presets. Picking one **writes the whole
fee curve AND which sub-autopilots run**, so the parts pull the same way. The detailed
per-subtab controls below still override anything afterwards.

Each preset sets the full fee curve, its **behaviour** (protect floor, profit-floor margin,
how fast idle channels get cheaper, how aggressive the explore-lower cut is) AND the
**rebalance economics** (strictness + per-run cap + daily fee budget). Base fee is 0 on all.

| Preset | min/neutral/max | protect | safety­Margin | ratchet steps | explore mod | Rebalance: econRatio / max·run / daily budget | Channels | Magma |
|---|---|---|---|---|---|---|---|---|
| **Max routing** | 25 / 60 / 1000 | 250 | 1.05 | 4 | 0.75 | 0.9 / 4 / 25k sat | on | **off** |
| **Balanced** (default) | 25 / 80 / 1000 | 350 | 1.15 | 3 | 0.85 | 0.8 / 2 / 10k sat | on | on, auto |
| **Max profit** | 80 / 150 / 1500 | 600 | 1.35 | 1 | 0.90 | 0.6 / 1 / 5k sat | **off** | on, premium |

Rationale: "Max routing" = cheapest fees + zero base + fast ratchet down + loose (still
profitable) rebalancing → win the most forwards (*lots of forwards for few sats*). "Max
profit" = higher fees, slow ratchet, strict rebalancing, lease idle capital rather than
route it. "Balanced" competes for flow while leasing idle capital.

**How the cascade reaches the engine:** the preset writes the persisted config's `policy`
object (`minPpm`, `neutralPpm`, `maxPpm`, `baseFeeMsat`, `protectPpm`, `safetyMargin`,
`noFlowRatchetSteps`, `exploreLowerModifier`), the `rebalancePolicy.econRatio` +
`maxRebalancesPerRun` + `rebalanceDailyBudgetSats`, and the on/off flags. On each run,
`feeV2Overrides()` maps `policy` → the fee engine's config. Still fixed across strategies
(not yet cascaded): `cooldownHours`, the flow windows, and the exact velocity/benchmark
tiers and the no-flow *trigger* (0 forwards / 30d) — only its *speed* is cascaded.

---

## 4. The other three sub-autopilots

**Rebalancing** (`runRebalances`): a recommender finds channels worth refilling and only
returns moves where the rebalance cost is economically justified vs the fee it would let us
earn (a `route_found_profitable` gate; `econRatio` is the cost/benefit knob). Runs at most
`maxRebalancesPerRun`, respects a per-target cooldown and an optional hour window. Each
attempt (success or fail) marks the target so we don't hammer dead routes.

**Channels** (`runChannels`): opens a channel to the top-scored peer suggestion when
on-chain funds exceed the reserve. **Capital gate:** if Magma selling is also on, it only
opens a routing channel when routing is expected to out-earn leasing that capital
(`routingYieldStats.medianPpmYear` vs a `leaseThresholdPpmYear` floor). Otherwise it leaves
the sats for Magma. This is the one place capital allocation is unified across routing vs
leasing.

**Magma** (`runMagma`): fulfils incoming sell orders by opening channels to buyers within
capital/size/reserve caps; reprices/relists our own offer per `sellPricingMode`
(`fast`/`balanced`/`premium`/`auto`, where auto adapts toward the income-maximising lease
price); optional auto-close/auto-relist. A 1% service fee applies to completed sales.

---

## 5. Config model (`AutopilotConfig`)

```
enabled, intervalMinutes, cooldownMinutes, maxChangesPerRun
policy: { minPpm, neutralPpm, maxPpm, baseFeeMsat, step, minChangePpm }
rebalanceEnabled, rebalancePolicy{econRatio, amountSats, maxLocalRatioTarget,
  minLocalRatioSource}, maxRebalancesPerRun, rebalanceCooldownMinutes,
  rebalanceHourStart, rebalanceHourEnd
channelEnabled, channelReserveSats, channelSizeSats, channelCooldownMinutes
sellEnabled, sellMaxDeploySats, sellReserveSats, sellMaxChannelSats,
  sellAutoClose, sellAutoRelist, sellAutoReprice, sellPricingMode
```

The Strategy presets only currently write: the four `*Enabled` flags, `policy` (min/neutral/
max/base), and `sellAutoReprice` + `sellPricingMode`.

---

## 6. Assessment — does this make sense, and where could it be better?

**What is sound:**
- One coherent goal beats per-subtab strategies that can contradict each other (e.g. "max
  profit fees" + "max volume rebalance" = pay to refill channels you then price out).
- Shifting the whole fee curve (min + neutral) plus zeroing the base fee is the right
  primary lever for forward count.
- The engine already resists the known failure mode (never slam a working channel up;
  never price-kill an idle one; learn per-channel elasticity).

**Open questions / candidate improvements (for the reviewing AI):**

1. ~~The Strategy only shifts the fee baseline + on/off.~~ **DONE** — presets now also set
   `protectPpm`, `safetyMargin`, `noFlowRatchetSteps` and `exploreLowerModifier` per goal.

2. ~~Rebalance economics aren't strategy-linked.~~ **DONE** — presets set `econRatio`,
   `maxRebalancesPerRun` and a new `rebalanceDailyBudgetSats` (daily rebalance-fee cap).

3. **The three presets conflate two axes:** *where to earn* (route vs lease) and *how
   aggressive on price* (volume vs margin). Would a 2-D model (goal × placement) be clearer,
   or does bundling keep it simple enough? Is three the right number?

4. ~~`minPpm` 10 on Max routing is near-zero.~~ **DONE** — Max routing now floors at 25 ppm
   (10 is left for a possible future "experimental / ultra-volume" mode).

5. **No closed-loop auto-tuning above the presets.** The engine learns per-channel
   elasticity, but the chosen strategy is static. Would an "auto" strategy that hill-climbs
   the node-wide revenue (or forward-count) target be worth it, or too unpredictable for a
   set-and-forget product? Note: over-automation previously caused an outage, so stability
   and explainability matter.

6. **Interactions to sanity-check:** the asymmetric cooldown (raises wait 72h, lowers are
   instant) combined with the no-flow ratchet — can a channel oscillate (drop to win flow →
   flow arrives → slowly raise → flow stops → drop again)? Is that healthy price discovery
   or churn? Should there be hysteresis?

7. **Base fee is globally 0.** Are there channel types (e.g. very large or premium peers)
   where a small base fee is worth keeping? Should base fee be strategy- or per-channel-set?

The goal is maximum sustainable yield, but with an explicit preference stated by the
operator: **more forwards for low fees is better than no forwards.** The "Max routing"
preset encodes that. The question is whether the cascade should reach deeper than the fee
baseline into the behavioral parameters and the other autopilots.
```
