import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "motion/react";

/** Same gold palette as GoldParticleField.tsx, reused here for visual consistency between the
 *  ambient background effect and this one-shot celebration burst. */
const GOLD_SHADES = ["201, 149, 43", "212, 168, 50", "230, 200, 105"];

interface BurstParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  life: number; // 0-1, counts down to 0
  decay: number;
}

const PARTICLE_COUNT = 90;

/** Full-screen canvas that fires a single upward/outward burst of gold particles from the
 *  top-center of the screen, then fades and unmounts itself - a one-time celebratory flourish
 *  for milestones (net worth going positive, a debt paid off, a goal completed), distinct from
 *  the always-on ambient GoldParticleField used on the profile picker. */
function ConfettiBurst() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const originX = width / 2;
    const originY = height * 0.18;

    const particles: BurstParticle[] = Array.from({ length: PARTICLE_COUNT }, () => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 1.5 + Math.random() * 4.5;
      return {
        x: originX,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 1.5, // slight upward bias
        radius: 1.5 + Math.random() * 2.5,
        color: GOLD_SHADES[Math.floor(Math.random() * GOLD_SHADES.length)],
        life: 1,
        decay: 0.006 + Math.random() * 0.01,
      };
    });

    let rafId: number;
    const gravity = 0.04;

    const tick = () => {
      ctx.clearRect(0, 0, width, height);
      let anyAlive = false;
      for (const p of particles) {
        if (p.life <= 0) continue;
        anyAlive = true;
        p.vy += gravity;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${Math.max(0, p.life)})`;
        ctx.fill();
      }
      if (anyAlive) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafId);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-[200] pointer-events-none"
      aria-hidden="true"
    />
  );
}

interface MilestoneCelebrationProps {
  /** The currently active milestone to celebrate, or null if none is showing. Parent owns the
   *  queue and should advance to the next one (or null) via `onDismiss`. */
  message: string | null;
  onDismiss: () => void;
}

/** Renders a one-time confetti burst + a dismissible banner for a single milestone message.
 *  Auto-dismisses after a few seconds; the parent is responsible for queuing multiple
 *  milestones one after another (pass the next message once `onDismiss` fires). */
export default function MilestoneCelebration({ message, onDismiss }: MilestoneCelebrationProps) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 4500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message]);

  return (
    <>
      <AnimatePresence>{message && <ConfettiBurst key={message} />}</AnimatePresence>
      <AnimatePresence>
        {message && (
          <motion.div
            key={message}
            initial={{ opacity: 0, y: -24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -24 }}
            transition={{ duration: 0.3 }}
            className="fixed top-6 left-1/2 -translate-x-1/2 z-[201] px-5 py-3 rounded-2xl shadow-lg cursor-pointer select-none"
            style={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid var(--gold)",
              boxShadow: "0 8px 24px rgba(201, 149, 43, 0.25)",
            }}
            onClick={onDismiss}
            role="status"
          >
            <p className="text-sm font-semibold" style={{ color: "var(--gold)" }}>{message}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
