// A single accessible usage meter: label, exact numbers, and a native `<progress>` element
// (browsers/screen readers announce its value/max natively - no custom `role="progressbar"`
// wiring needed). `max === null` renders the "kein Limit" state instead of a bar (Free's
// monthly limit - decisions/0017-billing-tiers-and-packages.md: "show that correctly, not as
// 0").
export function UsageProgressBar({
  label,
  current,
  max,
  unlimitedLabel,
}: {
  label: string;
  current: number;
  max: number | null;
  /** Shown in place of the bar when `max` is `null`. */
  unlimitedLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">{max === null ? unlimitedLabel : `${current} / ${max}`}</span>
      </div>
      {max === null ? null : <progress className="h-2 w-full accent-primary" value={current} max={Math.max(max, 1)} />}
    </div>
  );
}
