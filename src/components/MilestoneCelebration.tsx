import { useEffect, useRef } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Trophy, TrendingUp, Target, PiggyBank, Award } from "lucide-react";
import { useModalDismiss } from "@/hooks/useModalDismiss";
import type { MilestoneEvent, MilestoneIcon } from "@/lib/milestones";

/** Celebrations are green, not the app's gold - gold is reserved for "this is clickable"
 *  affordances, and a milestone is an outcome rather than a control. Kept as raw RGB triplets
 *  because the canvas can't resolve CSS custom properties. */
const GREEN_SHADES = ["16, 185, 129", "5, 150, 105", "52, 211, 153"];

/** Theme-aware green for the DOM chrome (--success shifts lightness between light/dark). */
const GREEN = "hsl(var(--success))";
const GREEN_TINT = "rgba(16, 185, 129, 0.14)";

interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  rotation: number;
  spin: number;
  color: string;
  life: number; // 0-1, counts down to 0
  decay: number;
}

const ICONS: Record<MilestoneIcon, typeof Trophy> = {
  trophy: Trophy,
  "trending-up": TrendingUp,
  target: Target,
  piggy: PiggyBank,
  award: Award,
};

/** Full-screen canvas that fires a burst of confetti, then fades and unmounts itself - a
 *  one-time celebratory flourish for milestones, distinct from the always-on ambient
 *  GoldParticleField used on the profile picker. Major milestones fire a wide two-cannon burst
 *  of tumbling ribbons; standard ones get the smaller original puff near the banner. */
function ConfettiBurst({ major }: { major: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const origins = major
      ? [
          { x: width * 0.12, y: height * 0.92, aim: -Math.PI / 3.4 },
          { x: width * 0.88, y: height * 0.92, aim: (-Math.PI * 2) / 3 },
        ]
      : [{ x: width / 2, y: height * 0.18, aim: -Math.PI / 2 }];
    const perOrigin = major ? 110 : 45;

    const particles: BurstParticle[] = origins.flatMap((origin) =>
      Array.from({ length: perOrigin }, () => {
        const spread = major ? Math.PI / 4 : Math.PI * 2;
        const angle = origin.aim + (Math.random() - 0.5) * spread;
        const speed = major ? 7 + Math.random() * 9 : 1.5 + Math.random() * 4.5;
        return {
          x: origin.x,
          y: origin.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - (major ? 0 : 1.5), // slight upward bias for the puff
          radius: 1.5 + Math.random() * (major ? 3.5 : 2.5),
          rotation: Math.random() * Math.PI,
          spin: (Math.random() - 0.5) * 0.3,
          color: GREEN_SHADES[Math.floor(Math.random() * GREEN_SHADES.length)],
          life: 1,
          decay: major ? 0.004 + Math.random() * 0.006 : 0.006 + Math.random() * 0.01,
        };
      })
    );

    let rafId: number;
    const gravity = major ? 0.18 : 0.04;
    const drag = major ? 0.985 : 0.99;

    const tick = () => {
      ctx.clearRect(0, 0, width, height);
      let anyAlive = false;
      for (const p of particles) {
        if (p.life <= 0) continue;
        anyAlive = true;
        p.vy += gravity;
        p.vx *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.spin;
        p.life -= p.decay;
        const alpha = Math.max(0, p.life);
        if (major) {
          // Tumbling ribbons read as confetti; squashing the height sells the 3D flip.
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rotation);
          ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
          ctx.fillRect(-p.radius, -p.radius * 1.8, p.radius * 2, p.radius * 3.6 * Math.abs(Math.cos(p.rotation)));
          ctx.restore();
        } else {
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
          ctx.fill();
        }
      }
      if (anyAlive) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, [major]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-[320] pointer-events-none"
      aria-hidden="true"
    />
  );
}

/** Centered congratulations dialog for major milestones - a paid-off debt, a completed goal, a
 *  six-figure net worth. Dismissible by button, backdrop click or Escape, but deliberately
 *  unmissable, unlike the banner used for smaller wins. */
function CelebrationDialog({ event, onDismiss }: { event: MilestoneEvent; onDismiss: () => void }) {
  const { onBackdropClick, containerRef } = useModalDismiss(onDismiss);
  const Icon = ICONS[event.icon];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={onBackdropClick} ref={containerRef}
      className="fixed inset-0 z-[321] flex items-center justify-center bg-black/60 backdrop-blur-md"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.85, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 12 }}
        transition={{ type: "spring", stiffness: 320, damping: 22 }}
        className="relative bg-[hsl(var(--background))] rounded-3xl px-12 py-14 w-[34rem] max-w-[92vw]
                   flex flex-col items-center gap-5 text-center"
        style={{
          border: `2px solid ${GREEN}`,
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.45), 0 0 90px rgba(16, 185, 129, 0.35)",
        }}
        role="alertdialog"
        aria-labelledby="milestone-title"
      >
        <motion.div
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 14, delay: 0.12 }}
          className="w-24 h-24 rounded-full flex items-center justify-center"
          style={{ backgroundColor: GREEN_TINT, border: "1px solid rgba(16, 185, 129, 0.45)" }}
        >
          <Icon size={46} style={{ color: GREEN }} strokeWidth={1.7} />
        </motion.div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] mb-3" style={{ color: GREEN }}>
            Milestone
          </p>
          <h2 id="milestone-title" className="text-4xl font-bold leading-tight" style={{ color: GREEN }}>
            {event.title}
          </h2>
        </div>

        <p className="text-base text-[hsl(var(--muted-foreground))] leading-relaxed max-w-[26rem]">
          {event.message}
        </p>

        <button
          onClick={onDismiss}
          className="mt-3 px-10 py-3 rounded-xl text-base font-semibold text-white transition-opacity hover:opacity-90"
          style={{ backgroundColor: GREEN }}
        >
          Nice
        </button>
      </motion.div>
    </motion.div>
  );
}

/** Top banner for standard milestones - visible but non-blocking, and auto-dismissing. */
function CelebrationBanner({ event, onDismiss }: { event: MilestoneEvent; onDismiss: () => void }) {
  const Icon = ICONS[event.icon];
  return (
    <motion.div
      initial={{ opacity: 0, y: -24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -24 }}
      transition={{ type: "spring", stiffness: 300, damping: 26 }}
      className="fixed top-6 left-1/2 -translate-x-1/2 z-[321] flex items-center gap-3.5 pl-5 pr-6 py-4
                 rounded-2xl cursor-pointer select-none max-w-[90vw]"
      style={{
        backgroundColor: "hsl(var(--background))",
        border: `1.5px solid ${GREEN}`,
        boxShadow: "0 12px 32px rgba(0, 0, 0, 0.25), 0 0 40px rgba(16, 185, 129, 0.25)",
      }}
      onClick={onDismiss}
      role="status"
    >
      <span
        className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center"
        style={{ backgroundColor: GREEN_TINT }}
      >
        <Icon size={22} style={{ color: GREEN }} strokeWidth={1.8} />
      </span>
      <span className="text-left">
        <p className="text-base font-semibold" style={{ color: GREEN }}>{event.title}</p>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">{event.message}</p>
      </span>
    </motion.div>
  );
}

interface MilestoneCelebrationProps {
  /** The currently active milestone to celebrate, or null if none is showing. The parent owns
   *  the queue and advances to the next one (or null) via `onDismiss` - see
   *  `useMilestoneQueue`. */
  event: MilestoneEvent | null;
  onDismiss: () => void;
}

/** Renders the confetti + congratulations UI for a single milestone. Major milestones get a
 *  centered dialog the user dismisses themselves; standard ones get an auto-dismissing banner. */
export default function MilestoneCelebration({ event, onDismiss }: MilestoneCelebrationProps) {
  const major = event?.tier === "major";
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!event || major) return; // dialogs wait for an explicit dismissal
    const t = setTimeout(onDismiss, 5000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, major]);

  return (
    <>
      <AnimatePresence>
        {event && !reducedMotion && <ConfettiBurst key={event.key} major={major} />}
      </AnimatePresence>
      <AnimatePresence>
        {event &&
          (major ? (
            <CelebrationDialog key={event.key} event={event} onDismiss={onDismiss} />
          ) : (
            <CelebrationBanner key={event.key} event={event} onDismiss={onDismiss} />
          ))}
      </AnimatePresence>
    </>
  );
}
