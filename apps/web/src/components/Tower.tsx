import { useEffect, useRef, useState } from 'react';

/**
 * The Fernsehturm with pulsing rings, drawn behind everything. Its centre line sits on the window's right edge, so
 * only the left half shows, on phones and wide screens alike; the spire tip ends just under the header date, the
 * rings are centred on the sphere, and the base stands on the bottom navigation (or the window's bottom edge where
 * there is none): the shaft takes up whatever height lies between.
 */
const CX = 337;
const CY = 237.6;
/** Frame and view box: the tower's centre is FRAME_RIGHT px from the frame's right edge. */
const FRAME_W = 430;
const FRAME_RIGHT = FRAME_W - (CX + 20);
/** The drawing: translate(242 32.4) scale(1.9); its base ends at y 400, so at 792.4 px from the top unstretched. */
const SCALE = 1.9;
const BASE_Y = 32.4 + SCALE * 400;
/** How far the shaft may shrink on short windows before the base would run into the sphere. */
const MIN_STRETCH = -150;

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

export function Tower({ aboveNav }: { aboveNav: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(BASE_Y);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setHeight(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Extra shaft, in drawing units, so the base meets the bottom of the box.
  const d = Math.max(MIN_STRETCH, (height - BASE_Y) / SCALE);
  return (
    <div
      ref={box}
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-0 overflow-hidden"
      // The nav is 64 px plus its 1 px top border, above the home indicator.
      style={{ bottom: aboveNav ? 'calc(65px + env(safe-area-inset-bottom, 0px))' : 0 }}
    >
      <div className="relative h-full">
        <svg
          className="absolute -top-[15px] overflow-visible"
          style={{ right: -FRAME_RIGHT }}
          width={FRAME_W}
          height={height + 15}
          viewBox={`-20 -15 ${FRAME_W} ${height + 15}`}
        >
          <Rings start={60} />
          <Rings start={80} />
          <Rings start={100} />
          <g
            transform={`translate(242 32.4) scale(${SCALE})`}
            fill="var(--tower-fill)"
            stroke="var(--tower-stroke)"
            strokeWidth={0.8}
            strokeLinejoin="round"
          >
            <path
              d={`M26 ${400 + d} C36 ${394 + d} 41 ${372 + d} 45 ${338 + d} L55 ${338 + d} C59 ${372 + d} 64 ${394 + d} 74 ${400 + d} Z`}
            />
            <path d={`M45.5 ${340 + d} L47.5 132 L52.5 132 L54.5 ${340 + d} Z`} />
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
