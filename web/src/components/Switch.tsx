/** iOS-style toggle: green track when on, red when off. */
export function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "on" : "off"}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

/** Pulsing green ON / static red OFF status pill. */
export function RunState({ on }: { on: boolean }) {
  return <span className={`run-state ${on ? "on" : "off"}`}>{on ? "ON" : "OFF"}</span>;
}
