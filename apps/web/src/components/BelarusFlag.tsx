/**
 * The white-red-white flag of the Belarusian democratic movement, drawn: no emoji exists for it (🇧🇾 is the
 * official red-green one). Fixed colours, with a hairline so the white stripes show on a light background.
 */
export function BelarusFlag({ className = 'h-3 w-[18px]' }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 12" className={`${className} shrink-0`} role="img" aria-label="White-red-white flag">
      <rect width="18" height="12" fill="#fff" />
      <rect y="4" width="18" height="4" fill="#c8313e" />
      <rect x="0.25" y="0.25" width="17.5" height="11.5" fill="none" stroke="#9aa0a6" strokeWidth="0.5" />
    </svg>
  );
}
