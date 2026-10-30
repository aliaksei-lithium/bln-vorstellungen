/**
 * The Fernsehturm with pulsing rings, drawn behind everything. Coordinates are page pixels inside a 390-wide frame
 * pinned to the right edge of the content column: the spire tip ends just under the header date, the rings are
 * centred on the sphere.
 */
const CX = 337;
const CY = 237.6;

function Rings({ start }: { start: number }) {
  const radii: number[] = [];
  for (let r = start; r <= 800; r += 60) radii.push(r);
  return (
    <g className="tower-ring" style={{ animationDelay: `${-((start - 60) / 20) * 3}s` }}>
      {radii.map((r) => (
        <circle key={r} cx={CX} cy={CY} r={r} fill="none" stroke="var(--ring-line)" strokeWidth={1} />
      ))}
    </g>
  );
}

export function Tower() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      <div className="relative mx-auto h-full max-w-[600px]">
        <svg
          className="absolute -top-[15px] -right-5 overflow-visible"
          width={430}
          height={874}
          viewBox="-20 -15 430 874"
        >
          <Rings start={60} />
          <Rings start={80} />
          <Rings start={100} />
          <g
            transform="translate(242 32.4) scale(1.9)"
            fill="var(--tower-fill)"
            stroke="var(--tower-stroke)"
            strokeWidth={0.8}
            strokeLinejoin="round"
          >
            <path d="M26 400 C36 394 41 372 45 338 L55 338 C59 372 64 394 74 400 Z" />
            <path d="M45.5 340 L47.5 132 L52.5 132 L54.5 340 Z" />
            <path d="M47.5 78 L52.5 78 L50.6 4 L49.4 4 Z" />
            <rect x={44} y={76} width={12} height={6} />
            <circle cx={50} cy={108} r={27} />
            <path d="M23.3 104 H76.7 M23.3 112 H76.7" fill="none" />
          </g>
        </svg>
      </div>
    </div>
  );
}
