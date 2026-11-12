import type { ReactNode } from "react";
import { goTo } from "../nav";
import type { SettingsSection } from "./SettingsPanel";

/**
 * A place that says "in Settings" leads there: Settings opens at that
 * section and marks it (review 2026-11-10, SET-4 — before, the texts only
 * named Settings, and the way there was a bare gear).
 */
export function SettingsLink({
  section,
  children,
  look = "link",
  onGo,
}: {
  section: SettingsSection;
  children: ReactNode;
  look?: "link" | "primary" | "row";
  /** Before going: what the link sits in closes (the node details, which
   *  would else stay over Settings — independent review of P10, F2). */
  onGo?: () => void;
}) {
  const className = look === "primary" ? "primary-btn" : look === "row" ? "row-btn" : "linklike";
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        onGo?.();
        goTo("settings", section);
      }}
    >
      {children}
    </button>
  );
}

/** "Connect Amboss": the button wherever a missing or rejected key stops something. */
export function ConnectAmbossButton({ label = "Connect Amboss", small = false }: { label?: string; small?: boolean }) {
  return (
    <SettingsLink section="amboss" look={small ? "row" : "primary"}>
      {label}
    </SettingsLink>
  );
}
