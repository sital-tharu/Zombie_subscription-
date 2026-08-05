/**
 * The mark: a pulse that stops, and a charge that doesn't.
 *
 * Green is genuine usage, red is the billing that carried on after it. That is
 * the entire product in one glyph, which is why it is drawn rather than
 * imported -- an SVG scales to a 16px favicon without blurring, weighs about a
 * kilobyte, and has no white box to punch out in dark mode.
 *
 * The tile stays dark in both colour schemes on purpose. The stroke colours are
 * the BRIGHT ends of the verdict palette; against the light scheme's darkened
 * red and green they would lose contrast on a dark tile, so the mark keeps its
 * own fixed pair instead of inheriting the theme.
 */
export function Logo({ size = 44, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Zombie"
      className={className}
    >
      <rect width="48" height="48" rx="13" fill="#111827" />
      {/* The pulse: two beats of real usage. */}
      <path
        d="M6 24h4.5l2.4-7.5 3.2 15 2.9-11 1.9 3.5h2.1"
        stroke="#3fb950"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* The flatline: the money still leaving, after the usage stopped. */}
      <path d="M23 24h19" stroke="#ff5f56" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
