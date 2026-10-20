import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  applyPatch,
  rebalanceWindowOpen,
  sanitizePersistedConfig,
  schedulerIntervalMs,
  validateAutopilotPatch,
  type AutopilotConfig,
} from "../src/services/autopilotConfig.js";
import { Autopilot, type AutopilotRun } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { stateAlerts } from "../src/services/alerts.js";
import type { SuggestionV2, SuggestV2Report } from "../src/services/suggestRecommend.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";

const ok = (body: unknown) => validateAutopilotPatch(body, DEFAULT_CONFIG);
const errorsOf = (body: unknown): string[] => {
  const r = ok(body);
  return r.ok ? [] : r.errors;
};

test("the Strategy presets and the defaults are valid", () => {
  const presets = [
    {
      enabled: true, rebalanceEnabled: true, channelEnabled: true, sellEnabled: false,
      policy: { minPpm: 25, neutralPpm: 60, maxPpm: 1000, baseFeeMsat: 0, protectPpm: 250, safetyMargin: 1.05, noFlowRatchetSteps: 4, exploreLowerModifier: 0.75 },
      rebalancePolicy: { econRatio: 0.9 }, maxRebalancesPerRun: 4, rebalanceDailyBudgetSats: 25_000,
    },
    {
      enabled: true, rebalanceEnabled: true, channelEnabled: false, sellEnabled: true,
      sellAutoReprice: true, sellAutoSize: true, sellPricingMode: "premium",
      policy: { minPpm: 80, neutralPpm: 150, maxPpm: 1500, baseFeeMsat: 0, protectPpm: 600, safetyMargin: 1.35, noFlowRatchetSteps: 1, exploreLowerModifier: 0.9 },
      rebalancePolicy: { econRatio: 0.6 }, maxRebalancesPerRun: 1, rebalanceDailyBudgetSats: 5_000,
    },
    DEFAULT_CONFIG,
  ];
  for (const p of presets) assert.deepEqual(errorsOf(p), []);
});

test("rejects every value the old endpoint silently stored", () => {
  const cases: [unknown, RegExp][] = [
    [{ intervalMinutes: 40_000 }, /intervalMinutes must be a whole number between 5 and 35791/],
    [{ intervalMinutes: 0 }, /intervalMinutes/],
    [{ intervalMinutes: 4.5 }, /intervalMinutes/],
    [{ intervalMinutes: "30" }, /intervalMinutes .*got "30"/],
    [{ intervalMinutes: null }, /intervalMinutes/],
    [{ enabled: "false" }, /enabled must be true or false/],
    [{ policy: null }, /policy must be an object/],
    [{ policy: { step: 0 } }, /policy\.step/],
    [{ rebalanceDailyBudgetSats: 0 }, /rebalanceDailyBudgetSats .*or null for no limit/],
    [{ channelReserveSats: 0 }, /channelReserveSats/],
    [{ rebalanceCooldownMinutes: 0 }, /rebalanceCooldownMinutes/],
    [{ policy: { minPpm: 900, maxPpm: 100 } }, /minPpm \(900\) must not exceed policy\.maxPpm/],
    [{ channelSizeSats: 5_000 }, /channelSizeSats must be 0 \(auto\) or at least 20000/],
    [{ sellPricingMode: "cheap" }, /sellPricingMode must be one of/],
    [{ rebalancePolicy: { econRatio: 2 } }, /rebalancePolicy\.econRatio/],
    ["not an object", /JSON object/],
  ];
  for (const [body, re] of cases) {
    const errs = errorsOf(body);
    assert.ok(errs.some((e) => re.test(e)), `${JSON.stringify(body)} → ${JSON.stringify(errs)}`);
  }
});

test("accepts an explicit 'no limit' budget and drops unknown keys", () => {
  const r = ok({ rebalanceDailyBudgetSats: null, someRemovedSetting: 5, policy: { minPpm: 30, legacy: true } });
  assert.ok(r.ok);
  assert.deepEqual(r.patch, { rebalanceDailyBudgetSats: null, policy: { minPpm: 30 } });
});

test("keys named like Object.prototype members are unknown keys too — dropped, never saved", () => {
  // As express.json() parses them: "__proto__" becomes an OWN key here.
  const body = JSON.parse(
    '{"constructor":1,"toString":2,"policy":{"constructor":5,"toString":7,"__proto__":3,"minPpm":30},' +
      '"rebalancePolicy":{"hasOwnProperty":1,"valueOf":2}}',
  ) as unknown;
  const r = ok(body);
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  // Before: `bounds[k]` found Object.prototype.constructor etc. as a "bound",
  // so these were accepted, merged into the live policy, and `${policy}` threw.
  assert.deepEqual(r.patch, { policy: { minPpm: 30 }, rebalancePolicy: {} });
  const merged = applyPatch(DEFAULT_CONFIG, r.patch);
  assert.deepEqual(Object.keys(merged.policy).sort(), Object.keys(DEFAULT_CONFIG.policy).sort());
  assert.deepEqual(Object.keys(merged.rebalancePolicy).sort(), Object.keys(DEFAULT_CONFIG.rebalancePolicy).sort());
  assert.doesNotThrow(() => String(merged.policy));

  const { config } = sanitizePersistedConfig(body);
  assert.deepEqual(Object.keys(config.policy).sort(), Object.keys(DEFAULT_CONFIG.policy).sort(), "nor loaded from disk");
});

test("settings already on disk are brought into range instead of crashing or looping", () => {
  const { config, repairs } = sanitizePersistedConfig({
    enabled: "false",
    intervalMinutes: 40_000,
    cooldownMinutes: 0,
    policy: null,
    rebalanceDailyBudgetSats: 0,
    sellMaxDeploySats: 3_000_000,
  });
  assert.equal(config.enabled, false);
  assert.equal(config.intervalMinutes, 35_791, "the longest interval a timer can hold");
  assert.equal(config.cooldownMinutes, 30);
  assert.deepEqual(config.policy, DEFAULT_CONFIG.policy);
  assert.equal(config.rebalanceDailyBudgetSats, null, "legacy 0 meant 'no cap' — kept, but explicit now");
  assert.equal(config.sellMaxDeploySats, 3_000_000, "valid values are kept");
  assert.equal(repairs.length, 5);
  assert.equal(schedulerIntervalMs(40_000), 35_791 * 60_000);
  assert.equal(schedulerIntervalMs("abc"), 30 * 60_000);
});

test("a stored 40,000-minute interval no longer turns the autopilot into a 1 ms loop", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { enabled: true, intervalMinutes: 40_000 }, history: [], sellAutoSizeMigrated: true }),
  );
  const node = new FakeLnd();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => autopilot.shutdown());
  let runs = 0;
  t.mock.method(autopilot, "runOnce", async () => {
    runs += 1;
    return {} as AutopilotRun;
  });
  autopilot.start();
  await new Promise((r) => setTimeout(r, 300));
  // Before: setInterval(fn, 2.4e9) → Node clamps it to 1 ms → hundreds of runs.
  assert.equal(runs, 0, "nothing runs before the 2 s start-up kick, let alone every millisecond");
  assert.equal(autopilot.getState().config.intervalMinutes, 35_791);
});

test("the scheduler clamps the interval itself, whatever got into the settings", async (t) => {
  const { autopilot } = autopilotOnDisk(t, { config: { enabled: true }, history: [], ...ALL_MIGRATED });
  let runs = 0;
  t.mock.method(autopilot, "runOnce", async () => {
    runs += 1;
    return {} as AutopilotRun;
  });
  // A value that got past both the API's validation and the load-time repair
  // (a future code path, a hand-edited file read some other way): the timer
  // itself must still never be handed a delay Node turns into 1 ms.
  (autopilot as unknown as { state: { config: AutopilotConfig } }).state.config.intervalMinutes = 40_000;
  autopilot.start();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(runs, 0, "no back-to-back runs");
});

test("POST /autopilot answers 400 naming the bad field, and saves nothing", async (t) => {
  const api = await startApi(t);
  const bad = await api.request("POST", "/autopilot", { intervalMinutes: 40_000, enabled: true });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /intervalMinutes/);
  const flag = await api.request("POST", "/autopilot", { enabled: "false" });
  assert.equal(flag.status, 400);
  const state = await api.request("GET", "/autopilot");
  assert.equal(state.body.config.intervalMinutes, 30);
  assert.equal(state.body.config.enabled, false, "the valid half of the rejected update was not applied either");
  assert.equal(state.body.bounds.config.intervalMinutes.max, 35_791, "bounds are published for the UI");

  const good = await api.request("POST", "/autopilot", { intervalMinutes: 60, rebalanceDailyBudgetSats: null });
  assert.equal(good.status, 200);
  assert.equal(good.body.config.intervalMinutes, 60);
  assert.equal(good.body.config.rebalanceDailyBudgetSats, null);
});

/** An Autopilot over a data dir holding `stored` as its autopilot.json. */
function autopilotOnDisk(t: { after(fn: () => void): void }, stored: Record<string, unknown>) {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify(stored));
  const node = new FakeLnd();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => autopilot.shutdown());
  const onDisk = () => JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { config: AutopilotConfig };
  return { autopilot, onDisk };
}

/** The constructor's upgrade migrations must still see the RAW stored config
 *  (sanitizing fills in defaults — 0.7.6 broke exactly this ordering). */
function autopilotFrom(t: { after(fn: () => void): void }, stored: Record<string, unknown>) {
  return autopilotOnDisk(t, stored).autopilot.getState().config;
}

const ALL_MIGRATED = { sellAutoSizeMigrated: true, intervalMigrated: true, feePolicyMigrated: true, feeVolumeMigrated: true };

test("a balanced fee level outside the fee range (as the 0.7.7 UI could save it) is repaired on load, and logged", () => {
  const cases: [{ minPpm: number; neutralPpm: number; maxPpm: number }, number, string][] = [
    [{ minPpm: 100, neutralPpm: 80, maxPpm: 1000 }, 100, "floor raised past the balanced level"],
    [{ minPpm: 25, neutralPpm: 0, maxPpm: 1000 }, 25, "balanced level blanked to 0"],
    [{ minPpm: 80, neutralPpm: 150, maxPpm: 120 }, 120, "ceiling lowered below the balanced level"],
  ];
  for (const [policy, neutral, why] of cases) {
    const { config, repairs } = sanitizePersistedConfig({ enabled: true, policy });
    assert.equal(config.policy.neutralPpm, neutral, why);
    assert.equal(config.policy.minPpm, policy.minPpm, `${why}: the operator's range is kept`);
    assert.equal(config.policy.maxPpm, policy.maxPpm, `${why}: the operator's range is kept`);
    assert.ok(repairs.some((r) => r.startsWith("policy.neutralPpm")), `${why}: ${JSON.stringify(repairs)}`);
  }
});

test("a switch is never refused because of what is stored; changing the range itself still is checked", () => {
  // Inconsistent the way an older version could leave it (bypassing the
  // load-time repair on purpose): neutral below the floor, a sub-minimum size.
  const stored: AutopilotConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    rebalanceEnabled: true,
    channelSizeSats: 5_000,
    policy: { ...DEFAULT_CONFIG.policy, minPpm: 100, neutralPpm: 80 },
  };
  const bodies: unknown[] = [
    { enabled: false },
    { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false },
    { sellPricingMode: "fast" },
    { intervalMinutes: 60 },
    { policy: { step: 5 } },
  ];
  for (const body of bodies) {
    const r = validateAutopilotPatch(body, stored);
    assert.ok(r.ok, `${JSON.stringify(body)} → ${r.ok ? "" : r.errors.join("; ")}`);
  }
  const range = validateAutopilotPatch({ policy: { maxPpm: 900 } }, stored);
  assert.equal(range.ok, false);
  assert.match(
    range.ok ? "" : range.errors.join("; "),
    /policy\.neutralPpm \(80\) must lie between policy\.minPpm \(100\) and policy\.maxPpm \(900\)/,
  );
  assert.equal(validateAutopilotPatch({ channelSizeSats: 10_000 }, stored).ok, false);
});

test("an upgraded install with an inconsistent stored fee range can still switch automation off", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: { enabled: true, rebalanceEnabled: true, policy: { ...DEFAULT_CONFIG.policy, minPpm: 100, neutralPpm: 80, maxPpm: 1000 } },
      history: [],
      ...ALL_MIGRATED,
    }),
  );
  const warn = t.mock.method(console, "warn", () => undefined);
  const api = await startApi(t, { dir });
  assert.ok(
    warn.mock.calls.some((c) => /settings repaired — policy\.neutralPpm: 80 .* using 100/.test(String(c.arguments[0]))),
    "the repair is logged",
  );
  const off = await api.request("POST", "/autopilot", { enabled: false });
  assert.equal(off.status, 200, off.body?.message);
  const rebalanceOff = await api.request("POST", "/autopilot", { rebalanceEnabled: false });
  assert.equal(rebalanceOff.status, 200, rebalanceOff.body?.message);

  const state = await api.request("GET", "/autopilot");
  assert.equal(state.body.config.enabled, false);
  assert.equal(state.body.config.rebalanceEnabled, false);
  assert.equal(state.body.config.policy.neutralPpm, 100, "moved to the nearest end of the range");
  const onDisk = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { config: AutopilotConfig };
  assert.equal(onDisk.config.policy.neutralPpm, 100, "and the repair is saved");
});

test("the one-shot fee migrations can't leave the fee range inconsistent", (t) => {
  // Before the volume-first rework: a 2,500 ppm ceiling with the balanced
  // level at 1,500. The migration lowers the ceiling to 1,000.
  const { autopilot, onDisk } = autopilotOnDisk(t, {
    config: { policy: { ...DEFAULT_CONFIG.policy, minPpm: 25, neutralPpm: 1_500, maxPpm: 2_500 } },
    history: [],
    sellAutoSizeMigrated: true,
    intervalMigrated: true,
    feeVolumeMigrated: true,
  });
  autopilot.start();
  const config = autopilot.getState().config;
  assert.equal(config.policy.maxPpm, 1_000, "the old ceiling is lowered, as before");
  assert.equal(config.policy.neutralPpm, 1_000, "and the balanced level moves with it");
  const save = validateAutopilotPatch({ policy: { minPpm: 30 } }, config);
  assert.ok(save.ok, `a later save touching the fee range goes through: ${save.ok ? "" : save.errors.join("; ")}`);
  assert.equal(onDisk().config.policy.neutralPpm, 1_000, "the repair is saved");
});

test("a policy saved before the balanced level existed still gets the default one on upgrade", (t) => {
  // Saved before the volume-first migration: no neutralPpm yet, and a floor
  // above the default balanced level (80), which the migration then lowers.
  const { autopilot } = autopilotOnDisk(t, {
    config: { policy: { minPpm: 100, maxPpm: 2_000, baseFeeMsat: 1_000, step: 10, minChangePpm: 25 } },
    history: [],
    sellAutoSizeMigrated: true,
  });
  autopilot.start();
  const p = autopilot.getState().config.policy;
  assert.deepEqual([p.minPpm, p.neutralPpm, p.maxPpm, p.baseFeeMsat], [25, 80, 1_000, 0]);
});

test("upgrading never loosens a safety limit: 'no fee changes' and large reserves are kept", () => {
  const { config, repairs } = sanitizePersistedConfig({
    enabled: true,
    maxChangesPerRun: 0, // what a blank field saved in 0.7.7: apply no fee changes
    channelReserveSats: 2_000_000_000, // 20 BTC
    sellReserveSats: 1_500_000_000,
  });
  assert.equal(config.maxChangesPerRun, 0, "still 'no fee changes' — not 1");
  assert.equal(config.channelReserveSats, 2_000_000_000, "a big reserve is never shrunk");
  assert.equal(config.sellReserveSats, 1_500_000_000);
  assert.deepEqual(repairs, []);
  assert.ok(ok({ maxChangesPerRun: 0, channelReserveSats: 3_000_000_000 }).ok, "and both can be set that way");
  assert.equal(ok({ channelReserveSats: 0 }).ok, false, "the reserve floor still holds");
});

test("upgrading never lets a stored value that kept rebalancing idle start it", () => {
  // A blank "Econ ratio" field saved 0 in 0.7.7: every rebalance's cost cap
  // was 0. Raised to the 0.05 minimum, rebalances would start paying fees.
  for (const econRatio of [0, 0.01, -1, null, "0.3"]) {
    const { config, repairs } = sanitizePersistedConfig({ rebalanceEnabled: true, rebalancePolicy: { econRatio } });
    const what = `econRatio ${JSON.stringify(econRatio)}`;
    assert.equal(config.rebalanceEnabled, false, `${what}: rebalancing is switched off, not started`);
    assert.ok(
      repairs.some((r) => /^rebalanceEnabled: switched off — the stored econ ratio/.test(r)),
      `${what}: and the operator is told why: ${JSON.stringify(repairs)}`,
    );
    assert.ok(config.rebalancePolicy.econRatio >= 0.05, `${what}: the stored value itself is valid again`);
  }
  // Above the maximum it is only lowered: a smaller budget, nothing to stop.
  const high = sanitizePersistedConfig({ rebalanceEnabled: true, rebalancePolicy: { econRatio: 2 } });
  assert.equal(high.config.rebalanceEnabled, true);
  assert.equal(high.config.rebalancePolicy.econRatio, 1);
  // Off already: nothing to switch, the value is just repaired.
  const off = sanitizePersistedConfig({ rebalanceEnabled: false, rebalancePolicy: { econRatio: 0 } });
  assert.equal(off.config.rebalanceEnabled, false);
  assert.ok(!off.repairs.some((r) => r.startsWith("rebalanceEnabled")));

  // An hour window that never opened (the 0.7.7 UI took any hour) would
  // become "any time" once clamped to 24→24.
  const never = sanitizePersistedConfig({ rebalanceEnabled: true, rebalanceHourStart: 25, rebalanceHourEnd: 26 });
  assert.equal(never.config.rebalanceEnabled, false);
  assert.ok(never.repairs.some((r) => /hour window 25→26 never opened/.test(r)), JSON.stringify(never.repairs));
  // A window that only needs clamping keeps its hours, and rebalancing.
  const late = sanitizePersistedConfig({ rebalanceEnabled: true, rebalanceHourStart: 22, rebalanceHourEnd: 30 });
  assert.equal(late.config.rebalanceEnabled, true);
  assert.deepEqual([late.config.rebalanceHourStart, late.config.rebalanceHourEnd], [22, 24]);
});

test("upgrading keeps what the engine did with an inverted fee range, a sub-minimum size and long cooldowns", () => {
  // min > max: the engine's clamp held every fee at the ceiling. The default
  // range instead would have dropped the effective floor to 25 ppm.
  const inverted = sanitizePersistedConfig({ enabled: true, policy: { minPpm: 2_000, maxPpm: 1_500 } });
  const p = inverted.config.policy;
  assert.deepEqual([p.minPpm, p.neutralPpm, p.maxPpm], [1_500, 1_500, 1_500]);
  assert.ok(inverted.repairs.some((r) => r.startsWith("policy.minPpm: 2000 is above maxPpm 1500 — using 1500")));

  // A positive size below the minimum never opened anything (the open is
  // refused). 0 would mean "auto" (the full recommended size): the minimum is
  // the closest valid size — and as the channel autopilot never opened with
  // the stored one, it is switched off rather than started by the upgrade.
  for (const stored of [15_000, 1, 0.4]) {
    const { config, repairs } = sanitizePersistedConfig({ channelEnabled: true, channelSizeSats: stored });
    assert.equal(config.channelSizeSats, 20_000, `stored ${stored}`);
    assert.equal(config.channelEnabled, false, `stored ${stored}: no auto-open starts on upgrade`);
    assert.ok(repairs.includes(`channelSizeSats: ${stored} is below 20000 — using 20000`), JSON.stringify(repairs));
    assert.ok(repairs.some((r) => r.startsWith("channelEnabled: switched off")), JSON.stringify(repairs));
  }
  const idle = sanitizePersistedConfig({ channelEnabled: false, channelSizeSats: 15_000 });
  assert.equal(idle.config.channelSizeSats, 20_000, "off already: only the size is repaired");
  assert.equal(idle.repairs.length, 1);

  // Above the 10 BTC ceiling: 0.7.7 opened only once the on-chain balance
  // covered the whole stored size. Clamped to 10 BTC, a node with 10–20 BTC to
  // spare would open a 10 BTC channel 0.7.7 never opened — switched off instead.
  const wumbo = sanitizePersistedConfig({ channelEnabled: true, channelSizeSats: 2_000_000_000 });
  assert.equal(wumbo.config.channelSizeSats, 1_000_000_000, "the value itself is brought into range");
  assert.equal(wumbo.config.channelEnabled, false, "no 10 BTC auto-open starts on upgrade");
  assert.ok(
    wumbo.repairs.some((r) => /^channelEnabled: switched off — the stored channel size of 2000000000 sat is above/.test(r)),
    JSON.stringify(wumbo.repairs),
  );
  const wumboIdle = sanitizePersistedConfig({ channelEnabled: false, channelSizeSats: 2_000_000_000 });
  assert.deepEqual(wumboIdle.repairs, ["channelSizeSats: 2000000000 is outside 0–1000000000 — using 1000000000"]);
  const atCeiling = sanitizePersistedConfig({ channelEnabled: true, channelSizeSats: 1_000_000_000 });
  assert.equal(atCeiling.config.channelEnabled, true, "a size within range is left alone");
  assert.deepEqual(atCeiling.repairs, []);
  assert.equal(
    sanitizePersistedConfig({ channelSizeSats: -5 }).config.channelSizeSats,
    0,
    "0.7.7 read a negative size as 'auto' as well — unchanged",
  );

  // A mistyped switch goes off, whatever its default — never on.
  const typed = sanitizePersistedConfig({ enabled: "false", sellAutoReprice: 0, sellAutoSize: "" });
  assert.deepEqual([typed.config.enabled, typed.config.sellAutoReprice, typed.config.sellAutoSize], [false, false, false]);

  // A longer cooldown is only ever safer: never shortened to a tidy maximum.
  const slow = sanitizePersistedConfig({ cooldownMinutes: 100_000, rebalanceCooldownMinutes: 200_000, channelCooldownMinutes: 1_000_000 });
  assert.deepEqual(
    [slow.config.cooldownMinutes, slow.config.rebalanceCooldownMinutes, slow.config.channelCooldownMinutes],
    [100_000, 200_000, 1_000_000],
  );
  assert.deepEqual(slow.repairs, []);
});

test("upgrading keeps a run interval the old version honoured: a weekly autopilot stays weekly", () => {
  // 0.7.7 ran any interval up to the timer's limit as stored. A one-day
  // ceiling turned a weekly run into a daily one — 7× the runs, and up to 7×
  // the rebalance spend under the same daily budget — with automation left on.
  for (const stored of [2_880, 10_080, 35_791]) {
    const { config, repairs } = sanitizePersistedConfig({
      enabled: true,
      rebalanceEnabled: true,
      channelEnabled: true,
      intervalMinutes: stored,
    });
    assert.equal(config.intervalMinutes, stored);
    assert.deepEqual(repairs, [], `stored ${stored}: nothing to repair`);
    assert.deepEqual([config.enabled, config.rebalanceEnabled, config.channelEnabled], [true, true, true]);
    assert.equal(schedulerIntervalMs(stored), stored * 60_000, `stored ${stored}: scheduled as stored`);
  }
  assert.equal(schedulerIntervalMs(10_080), 604_800_000);
  assert.ok(ok({ intervalMinutes: 10_080 }).ok, "and a weekly run can be set");
  // One minute more and Node's timer overflows into a 1 ms loop — what 0.7.7
  // did with it. The ceiling is the slowest interval that still works.
  assert.ok(schedulerIntervalMs(35_791) <= 2 ** 31 - 1);
  assert.ok(35_792 * 60_000 > 2 ** 31 - 1);
  assert.equal(sanitizePersistedConfig({ intervalMinutes: 35_792 }).config.intervalMinutes, 35_791);
});

test("a weekly interval on disk still runs weekly after the upgrade, not daily", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { autopilot } = autopilotOnDisk(t, { config: { enabled: true, intervalMinutes: 10_080 }, history: [], ...ALL_MIGRATED });
  let runs = 0;
  t.mock.method(autopilot, "runOnce", async () => {
    runs += 1;
    return {} as AutopilotRun;
  });
  autopilot.start();
  t.mock.timers.tick(2_000);
  assert.equal(runs, 1, "the run shortly after start-up");
  t.mock.timers.tick(24 * 3_600_000);
  assert.equal(runs, 1, "no daily run");
  t.mock.timers.tick(6 * 24 * 3_600_000);
  assert.equal(runs, 2, "the weekly one");
});

test("a fraction stored in a whole-number setting is rounded toward doing less, never more", () => {
  const { config, repairs } = sanitizePersistedConfig({
    rebalanceEnabled: true,
    intervalMinutes: 7.4, // 0.7.7 ran every 7.4 min: 7 would run more often
    cooldownMinutes: 360.2,
    maxChangesPerRun: 2.6, // 0.7.7 sliced its plan with it: 2 changes, not 3
    maxRebalancesPerRun: 1.5,
    rebalanceHourStart: 5.4, // 0.7.7 compared whole clock hours: from 6, not 5
    rebalanceHourEnd: 6.4, // … and through 6: hour < 6.4 is hour < 7
  });
  assert.equal(config.intervalMinutes, 8);
  assert.equal(config.cooldownMinutes, 361);
  assert.equal(config.maxChangesPerRun, 2);
  assert.equal(config.maxRebalancesPerRun, 1);
  assert.deepEqual([config.rebalanceHourStart, config.rebalanceHourEnd], [6, 7]);
  for (let hour = 0; hour < 24; hour++) {
    assert.equal(rebalanceWindowOpen(6, 7, hour), hour >= 5.4 && hour < 6.4, `the same hours as before: ${hour}`);
  }
  assert.equal(config.rebalanceEnabled, true, "the window still opens — nothing to switch off");
  assert.ok(repairs.includes("maxChangesPerRun: 2.6 is not a whole number — using 2"), JSON.stringify(repairs));
});

test("a stored sub-minimum channel size never becomes a 2M auto-open: the upgrade opens nothing, and re-enabled it opens the minimum", async (t) => {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const peer = "02" + "cd".repeat(32);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [peer] });
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { channelEnabled: true, channelSizeSats: 15_000 }, history: [], ...ALL_MIGRATED }),
  );
  const warn = t.mock.method(console, "warn", () => undefined);
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => autopilot.shutdown());
  (autopilot as unknown as { channelSuggestions: () => Promise<Pick<SuggestV2Report, "suggestions">> }).channelSuggestions =
    async () => ({
      suggestions: [{ pubkey: peer, alias: "next-peer", socket: "", recommendedSizeSats: 2_000_000 } as SuggestionV2],
    });

  const opened = () => node.callsTo("default.openChannel").map((c) => Number(c.local_funding_amount));

  // Before: 0.7.7's idle 15,000 became 0 = "auto", and this run opened 2,000,000.
  const run = await autopilot.runOnce();
  assert.deepEqual(opened(), [], "the channel autopilot never opened with the stored size — the upgrade doesn't start it");
  assert.deepEqual(run.channels, []);
  assert.equal(autopilot.getState().config.channelEnabled, false);
  assert.ok(
    warn.mock.calls.some((c) => /settings repaired — channelSizeSats: 15000 is below 20000 — using 20000/.test(String(c.arguments[0]))),
    "the repair is logged",
  );
  assert.ok(
    stateAlerts(dir).some((a) => a.id && /autopilot settings .*channelEnabled: switched off/i.test(a.message)),
    "and raised as an alert the operator acknowledges",
  );

  // The operator reads the alert and switches it back on: the size is the
  // closest valid one, never the suggestion's 2,000,000.
  autopilot.setConfig({ channelEnabled: true });
  await autopilot.runOnce();
  assert.deepEqual(opened(), [20_000]);
});

test("a repair that switches rebalancing off reaches the UI as an alert, and is saved", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { rebalanceEnabled: true, rebalancePolicy: { econRatio: 0 } }, history: [], ...ALL_MIGRATED }),
  );
  t.mock.method(console, "warn", () => undefined);
  const api = await startApi(t, { dir });
  const state = await api.request("GET", "/autopilot");
  assert.equal(state.body.config.rebalanceEnabled, false);
  const alerts = (await api.request("GET", "/alerts")).body as { id?: string; message: string }[];
  const alert = alerts.find((a) => a.message.includes("rebalanceEnabled: switched off"));
  assert.ok(alert?.id, JSON.stringify(alerts));
  assert.equal((await api.request("POST", "/alerts/ack", { id: alert.id })).status, 200);

  const onDisk = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { config: AutopilotConfig };
  assert.equal(onDisk.config.rebalanceEnabled, false, "saved, so the next start doesn't repair (or alert) again");
  assert.equal(onDisk.config.rebalancePolicy.econRatio, 0.05);
});

test("upgrade migrations still behave: 0.7.5, 0.7.6 and a deliberate choice", (t) => {
  // 0.7.5: no sellAutoSize yet — it inherits auto-pricing's value.
  assert.equal(autopilotFrom(t, { config: { sellAutoReprice: false }, history: [] }).sellAutoSize, false);
  assert.equal(autopilotFrom(t, { config: { sellAutoReprice: true }, history: [] }).sellAutoSize, true);
  // 0.7.6 forced sizing ON with pricing OFF — undone.
  assert.equal(
    autopilotFrom(t, { config: { sellAutoReprice: false, sellAutoSize: true }, history: [] }).sellAutoSize,
    false,
  );
  // Already migrated, operator's explicit choice: untouched.
  assert.equal(
    autopilotFrom(t, { config: { sellAutoReprice: false, sellAutoSize: true }, history: [], sellAutoSizeMigrated: true })
      .sellAutoSize,
    true,
  );
});

