import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { edgeCentsThrough, edgeTxnsOnDay, layoutFlow, type FlowNodeKind, type LaidOutEdge, type LaidOutNode, type MoneyFlow } from "@/lib/flows";
import { harmonizeColor } from "@/lib/chartTheme";
import { formatCurrency, formatCurrencyWhole } from "@/lib/utils";

/**
 * The Chart's map: the month's money as currents between sources, accounts and destinations.
 * Ribbons are SVG strokes as wide as the money; the faint channel is the whole month and the
 * brighter current fills it up to the scrubbed day. Gold particles ride each ribbon (HTML
 * spans on a CSS motion path, so the SVG stays static and cheap), and the rows that posted
 * on the selected day send a short burst. Nothing moves when the day changes except the
 * currents' width: node positions come from month totals.
 */
export type FlowSelection = { type: "edge"; id: string } | { type: "node"; id: string };

interface MoneyFlowMapProps {
  flow: MoneyFlow;
  /** 0-based day of the month the scrubber is on. */
  day: number;
  selected: FlowSelection | null;
  onSelect: (selection: FlowSelection | null) => void;
  mode: "dark" | "light";
  reduced: boolean;
  /** Bumped by the parent whenever the user moves the day, so bursts fire on scrubbing only. */
  burstKey: number;
  height?: number;
}

const KIND_COLOR: Partial<Record<FlowNodeKind, string>> = {
  income: "hsl(var(--sea))",
  "transfer-in": "hsl(var(--sea))",
  account: "hsl(var(--sea))",
  card: "hsl(var(--sea))",
  savings: "hsl(var(--success))",
  investments: "hsl(var(--success))",
  debt: "hsl(var(--success))",
  "paid-down": "hsl(var(--success))",
  "from-balance": "hsl(var(--warning))",
  carried: "hsl(var(--warning))",
  bills: "hsl(var(--muted-foreground))",
  recurring: "hsl(var(--foreground))",
  "transfer-out": "hsl(var(--neutral))",
  other: "hsl(var(--neutral))",
  stayed: "hsl(var(--primary))",
};

const CAPTIONS: Record<number, string> = { 0: "Came from", 1: "Through", 2: "Went to", 3: "On the card" };
/** Room above the map for the column captions. */
const CAPTION_HEIGHT = 22;

export function flowColor(kind: FlowNodeKind, stored: string | null, mode: "dark" | "light"): string {
  if (kind === "category" && stored) return harmonizeColor(stored, mode);
  return KIND_COLOR[kind] ?? "hsl(var(--neutral))";
}

function truncate(label: string, max: number): string {
  return label.length > max ? `${label.slice(0, Math.max(1, max - 1)).trimEnd()}…` : label;
}

/** Wide ribbons go quieter so a dominant flow reads as a broad current, not a slab; thin ones
 *  stay bright enough to find. */
function ribbonAlpha(thickness: number): number {
  return Math.max(0.2, Math.min(0.5, 0.52 - thickness / 1100));
}

export default function MoneyFlowMap({ flow, day, selected, onSelect, mode, reduced, burstKey, height = 520 }: MoneyFlowMapProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const narrow = width > 0 && width < 640;
  const layout = useMemo(() => {
    if (width === 0) return null;
    return layoutFlow(flow, {
      width, height,
      gap: 12,
      gutterLeft: narrow ? 96 : 150,
      gutterRight: narrow ? 112 : 210,
    });
  }, [flow, width, height, narrow]);

  const nodeById = useMemo(() => new Map((layout?.nodes ?? []).map((n) => [n.id, n])), [layout]);
  const maxEdge = useMemo(() => Math.max(1, ...flow.edges.map((e) => e.cents)), [flow]);

  const isRelated = (e: LaidOutEdge): boolean => {
    if (!selected) return true;
    if (selected.type === "edge") return e.id === selected.id;
    return e.source === selected.id || e.target === selected.id;
  };
  const nodeRelated = (n: LaidOutNode): boolean => {
    if (!selected) return true;
    if (selected.type === "node") return n.id === selected.id;
    const e = layout?.edges.find((edge) => edge.id === selected.id);
    return !!e && (e.source === n.id || e.target === n.id);
  };

  const toggle = (sel: FlowSelection) => {
    if (selected && selected.type === sel.type && selected.id === sel.id) onSelect(null);
    else onSelect(sel);
  };
  const keyActivate = (sel: FlowSelection) => (event: KeyboardEvent<SVGElement>) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggle(sel); }
  };

  const labelMax = narrow ? 13 : 24;
  const rightLabelMax = narrow ? 15 : 30;
  const fontSize = narrow ? 11 : 12;
  const totalHeight = height + CAPTION_HEIGHT;

  if (!layout) return <div ref={wrapRef} className="flow-map" style={{ height: totalHeight }} />;

  const summary = `${flow.nodes.length} places and ${flow.edges.length} currents. ${formatCurrencyWhole(flow.totals.incomeCents)} came in, ${formatCurrencyWhole(flow.totals.spentCents)} was spent, ${formatCurrencyWhole(flow.totals.putAwayCents)} reached savings, investments or debt.`;
  const presentColumns = [0, 1, 2, 3].filter((c) => layout.nodes.some((n) => n.column === c));
  const lastColumn = presentColumns[presentColumns.length - 1];

  return (
    <div ref={wrapRef} className="flow-map" style={{ height: totalHeight }}>
      <div className="flow-captions" aria-hidden="true" style={{ height: CAPTION_HEIGHT }}>
        {presentColumns.map((c, i) => {
          const x = layout.columns[i];
          const leftAligned = c !== 0;
          return (
            <span key={c} style={leftAligned ? { left: x + 10 + 8 } : { right: width - (x - 8) }}>
              {CAPTIONS[c]}
            </span>
          );
        })}
      </div>
      <svg width={width} height={height} role="img" aria-label={summary} className="flow-svg">
        <g className="flow-ribbons">
          {layout.edges.map((e) => {
            const through = edgeCentsThrough(e, day);
            const fraction = e.cents > 0 ? Math.min(1, through / e.cents) : 0;
            const color = flowColor(e.kind, e.color, mode);
            const source = nodeById.get(e.source)?.label ?? "";
            const target = nodeById.get(e.target)?.label ?? "";
            const active = edgeTxnsOnDay(flow, e, day).length > 0;
            const sel: FlowSelection = { type: "edge", id: e.id };
            const isSel = selected?.type === "edge" && selected.id === e.id;
            return (
              <g
                key={e.id}
                className="flow-ribbon"
                data-selected={isSel || undefined}
                data-dim={!isRelated(e) || undefined}
                data-active={active || undefined}
                style={{ "--ribbon-alpha": ribbonAlpha(e.thickness) } as CSSProperties}
              >
                <path d={e.path} className="flow-channel" stroke={color} strokeWidth={e.thickness} fill="none" />
                {fraction > 0 && <path d={e.path} className="flow-current" stroke={color} strokeWidth={Math.max(1.5, e.thickness * fraction)} fill="none" />}
                <path d={e.path} className="flow-centerline" fill="none" />
                <path
                  d={e.path}
                  className="flow-hit"
                  strokeWidth={Math.max(e.thickness, 12)}
                  fill="none"
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${source} to ${target}, ${formatCurrency(e.cents)}, ${e.txnIds.length} ${e.txnIds.length === 1 ? "transaction" : "transactions"}`}
                  onClick={() => toggle(sel)}
                  onKeyDown={keyActivate(sel)}
                >
                  <title>{`${source} to ${target}: ${formatCurrency(through)}${fraction < 1 ? ` of ${formatCurrency(e.cents)}` : ""}`}</title>
                </path>
              </g>
            );
          })}
        </g>
        <g className="flow-nodes" style={{ fontSize }}>
          {layout.nodes.map((n) => {
            const color = flowColor(n.kind, n.color, mode);
            const left = n.column === 0;
            const tx = left ? n.x - 8 : n.x + n.width + 8;
            const cy = n.y + n.height / 2;
            const twoLines = n.height >= 26;
            const max = n.column === lastColumn && !left ? rightLabelMax : labelMax;
            const sel: FlowSelection = { type: "node", id: n.id };
            const isSel = selected?.type === "node" && selected.id === n.id;
            return (
              <g
                key={n.id}
                className="flow-node"
                data-selected={isSel || undefined}
                data-dim={!nodeRelated(n) || undefined}
                role="button"
                tabIndex={0}
                aria-pressed={isSel}
                aria-label={`${n.label}, ${formatCurrency(n.cents)}`}
                onClick={() => toggle(sel)}
                onKeyDown={keyActivate(sel)}
              >
                <rect x={n.x} y={n.y} width={n.width} height={n.height} rx={2} fill={color} className="flow-node-rect" />
                {isSel && <rect x={n.x - 2} y={n.y - 2} width={n.width + 4} height={n.height + 4} rx={3} className="flow-node-ring" />}
                <text x={tx} y={twoLines ? cy - 2 : cy} textAnchor={left ? "end" : "start"} dominantBaseline={twoLines ? "auto" : "middle"} className="flow-label">
                  {truncate(n.label, max)}
                  {!twoLines && <tspan className="flow-amount"> {formatCurrencyWhole(n.cents)}</tspan>}
                </text>
                {twoLines && (
                  <text x={tx} y={cy + 12} textAnchor={left ? "end" : "start"} className="flow-amount">
                    {formatCurrencyWhole(n.cents)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {!reduced && (
        <div className="flow-particles" aria-hidden="true" style={{ top: CAPTION_HEIGHT }}>
          {layout.edges.map((e) => {
            const through = edgeCentsThrough(e, day);
            if (through <= 0 || !isRelated(e)) return null;
            const count = Math.min(14, 1 + Math.round((13 * e.cents) / maxEdge));
            const spread = Math.max(0, e.thickness / 2 - 2);
            // Golden-ratio steps spread particles evenly across the ribbon's thickness.
            const offset = (i: number) => (spread === 0 ? 0 : -spread + spread * 2 * ((i * 0.618034 + 0.31) % 1));
            const particles = [];
            for (let i = 0; i < count; i++) {
              const dur = 7 + ((i * 1.7) % 4);
              particles.push(
                <span
                  key={`${e.id}-${i}`}
                  className="flow-particle"
                  style={{ offsetPath: `path("${e.path}")`, "--dur": `${dur}s`, "--delay": `${-((i / count) * dur).toFixed(2)}s`, "--ty": `${offset(i).toFixed(1)}px` } as CSSProperties}
                />
              );
            }
            if (burstKey > 0 && edgeTxnsOnDay(flow, e, day).length > 0) {
              for (let i = 0; i < 5; i++) {
                particles.push(
                  <span
                    key={`${e.id}-burst-${burstKey}-${i}`}
                    className="flow-particle flow-burst"
                    style={{ offsetPath: `path("${e.path}")`, "--dur": "1.3s", "--delay": `${(i * 0.09).toFixed(2)}s`, "--ty": `${offset(i + 3).toFixed(1)}px` } as CSSProperties}
                  />
                );
              }
            }
            return particles;
          })}
        </div>
      )}
    </div>
  );
}
