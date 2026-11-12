import { useEffect, useState } from "react";
import { goTo } from "../nav";
import { api } from "../api";
import { boundsFor } from "../autopilotForm";
import { allAutomationOff } from "../autopilotView";
import { satsCompact } from "../format";
import { SETUP_GOALS, setupDestination, setupLines, setupPatch, setupProblem, withoutSelling, type SetupChoice, type SetupGoal } from "../setupView";
import type { AutopilotState } from "../types";
import { useUi } from "./Overlay";
import { turnSellingOn } from "./SellingSwitch";

/**
 * The questions on a new install's first start: what the node is for, how much
 * the app may use, and what that will do. Skippable at every step, and shown
 * only to an install that has nothing set yet.
 */
export function SetupWizard({ onChanged }: { onChanged?: () => void }) {
  const ui = useUi();
  const [state, setState] = useState<AutopilotState | null>(null);
  const [show, setShow] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [freeSats, setFreeSats] = useState<number | null>(null);
  const [step, setStep] = useState<"goal" | "limits" | "review">("goal");
  const [choice, setChoice] = useState<SetupChoice>({ goal: "routing", openChannels: false, reserveSats: 50_000, sellEverything: false, sellCapSats: 2_000_000 });
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void api
      .getSettings()
      .then(async (s) => {
        if (s.setupDone) return;
        const [ap, key, chain] = await Promise.all([api.autopilotGet(), api.ambossStatus().catch(() => null), api.node().catch(() => null)]);
        if (gone) return;
        // Set up by hand, on or paused: no questions, now or later (a pause
        // switches everything off, and Start would end it and overwrite the fees).
        if (!allAutomationOff(ap.config) || ap.paused) {
          await api.setSettings({ setupDone: true }).catch(() => undefined);
          return;
        }
        if (!ap.canWrite) return;
        setState(ap);
        setHasKey(!!key?.connected);
        setFreeSats(chain?.balances.onchainConfirmedSats ?? null);
        setChoice((c) => ({ ...c, reserveSats: ap.config.channelReserveSats, sellCapSats: ap.config.sellMaxDeploySats }));
        setShow(true);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  if (!show || !state) return null;

  const finish = async (message?: string) => {
    await api.setSettings({ setupDone: true }).catch(() => undefined);
    setShow(false);
    if (message) ui.toast(message, "success");
    onChanged?.();
  };

  const pickGoal = (goal: SetupGoal) => {
    setChoice((c) => ({ ...c, goal }));
    setError(null);
    if (goal === "watch") void finish("Nothing runs on its own. The Autopilot tab has every switch.");
    else setStep("limits");
  };

  const sellCapTop = boundsFor(state.bounds, "sellMaxDeploySats")?.max ?? 1_000_000_000;
  const problem = setupProblem(choice, { reserve: boundsFor(state.bounds, "channelReserveSats"), cap: boundsFor(state.bounds, "sellMaxDeploySats") });

  const start = async () => {
    setBusy(true);
    setError(null);
    let keySaved = false;
    try {
      let keyNow = hasKey;
      if (choice.goal === "selling" && !keyNow && keyInput.trim()) {
        await api.ambossConnect(keyInput.trim());
        keyNow = true;
        keySaved = true;
        setHasKey(true);
        setKeyInput("");
      }
      // Selling's own dialog first: its live check, and the yes that is the
      // operator's alone. Nothing runs before it is answered: everything
      // switched on in one save, so no routing open can spend the coins meant
      // for selling while the dialog is up.
      let sellingYes = false;
      if (choice.goal === "selling" && keyNow) {
        await turnSellingOn({
          confirm: ui.confirm,
          eligibility: () => api.magmaEligibility(),
          offers: () => api.ambossMyOffers().then((r) => r.offers),
          offerSync: () => api.ambossOfferSync(),
          disableOffer: (id: string) => api.ambossToggleOffer(id, "DISABLED"),
          save: async () => {
            sellingYes = true;
            return true;
          },
          toast: ui.toast,
        });
      }
      const patch = setupPatch(choice, state.config, sellCapTop);
      await api.autopilotSet(sellingYes ? { ...patch, sellEnabled: true } : withoutSelling(patch));
      await finish(
        sellingYes
          ? "The autopilot is on, selling too. Every setting is under the Autopilot tab."
          : choice.goal === "selling"
            ? keyNow
              ? "The autopilot is on; selling stays off until you switch it on under Autopilot → Selling."
              : "The autopilot is on. Connect your Amboss key here, then switch selling on under Autopilot → Selling."
            : "The autopilot is on. Every setting is under the Autopilot tab.",
      );
      // Selling wanted, no key yet: straight to the steps that connect it.
      const dest = setupDestination(choice.goal, keyNow);
      if (dest) goTo(dest.tab, dest.section);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      setError(keySaved ? `${why} Your Amboss key is saved; nothing else changed.` : `${why} Nothing was changed.`);
    } finally {
      setBusy(false);
    }
  };

  const skip = (
    <button className="linklike" disabled={busy} onClick={() => void finish()}>
      Skip, I'll set it up myself
    </button>
  );

  return (
    <section className="panel setup">
      {step === "goal" ? (
        <>
          <h2>What do you want from this node?</h2>
          <div className="setup-goals">
            {SETUP_GOALS.map((g) => (
              <button key={g.id} className="setup-goal" onClick={() => pickGoal(g.id)}>
                <span className="setup-goal-label">{g.label}</span>
                <span className="muted small">{g.desc}</span>
              </button>
            ))}
          </div>
          <p className="setup-foot">{skip}</p>
        </>
      ) : step === "limits" ? (
        <>
          <h2>How much may it use?</h2>
          {freeSats !== null ? <p className="muted">Your on-chain wallet holds {satsCompact(freeSats)} sat.</p> : null}
          <div className="setup-fields">
            <label className="policy-field">
              <span>Always keep on chain (sat)</span>
              <input type="number" min={0} step={10_000} value={Number.isFinite(choice.reserveSats) ? choice.reserveSats : ""} onChange={(e) => setChoice({ ...choice, reserveSats: e.target.value === "" ? NaN : Number(e.target.value) })} />
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={choice.openChannels} onChange={(e) => setChoice({ ...choice, openChannels: e.target.checked })} />
              Open new channels by itself, with my on-chain funds
            </label>
            {choice.goal === "selling" ? (
              <div className="ap-capital">
                <span className="ap-capital-title">Capital to sell</span>
                <label>
                  <input type="radio" name="setup-capital" checked={choice.sellEverything} onChange={() => setChoice({ ...choice, sellEverything: true })} />
                  Everything free
                </label>
                <label>
                  <input type="radio" name="setup-capital" checked={!choice.sellEverything} onChange={() => setChoice({ ...choice, sellEverything: false })} />
                  At most
                </label>
                {choice.sellEverything ? null : (
                  <label className="policy-field">
                    <span>sat</span>
                    <input type="number" min={20_000} step={100_000} value={Number.isFinite(choice.sellCapSats) ? choice.sellCapSats : ""} onChange={(e) => setChoice({ ...choice, sellCapSats: e.target.value === "" ? NaN : Number(e.target.value) })} />
                  </label>
                )}
              </div>
            ) : null}
            {choice.goal === "selling" && !hasKey ? (
              <label className="policy-field setup-key">
                <span>
                  Amboss key, from{" "}
                  <a href="https://account.amboss.tech/settings/api-keys" target="_blank" rel="noreferrer">
                    account.amboss.tech
                  </a>{" "}
                  (optional now, needed to sell — no key yet? After the start, Settings shows you how, step by step)
                </span>
                <input type="password" value={keyInput} autoComplete="off" onChange={(e) => setKeyInput(e.target.value)} />
              </label>
            ) : null}
          </div>
          {problem ? <p className="sug-warn">⚠ {problem}</p> : null}
          <div className="setup-actions">
            <button className="reset" onClick={() => setStep("goal")}>
              Back
            </button>
            <button className="primary-btn" disabled={problem !== null} onClick={() => setStep("review")}>
              Next
            </button>
            {skip}
          </div>
        </>
      ) : (
        <>
          <h2>This is what it will do</h2>
          <ul className="setup-lines">
            {setupLines(choice, state.config, hasKey || keyInput.trim().length > 0).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="muted small">You can change or pause all of it any time on the Autopilot tab.</p>
          {error ? <p className="banner error">{error}</p> : null}
          <div className="setup-actions">
            <button className="reset" disabled={busy} onClick={() => setStep("limits")}>
              Back
            </button>
            <button className="primary-btn" disabled={busy} onClick={() => void start()}>
              {busy ? "Starting…" : "Start"}
            </button>
            {skip}
          </div>
        </>
      )}
    </section>
  );
}
