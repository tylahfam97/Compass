import { useEffect, useRef } from "react";
import { useAppReducedMotion } from "@/hooks/useAppReducedMotion";

/** Gold tones particles are randomly drawn from, for a bit of visual depth. */
const GOLD_SHADES = ["201, 149, 43", "212, 168, 50", "230, 200, 105"];

interface Particle {
  depth: number;
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  baseAlpha: number;
  twinkleSpeed: number;
  twinklePhase: number;
  /** Small autonomous drift around its resting position - keeps the field alive
   *  (jiggling/orbiting ever so slightly) even when the cursor never comes near it. */
  wanderRadius: number;
  wanderSpeed: number;
  wanderPhase: number;
}

const PARTICLE_COUNT = 420;
const REPEL_RADIUS = 110;
const REPEL_STRENGTH = 1400;
const SPRING_K = 0.02;
const DAMPING = 0.9;

/** Ellipse (as a fraction of width/height) that particles avoid spawning inside,
 *  so the profile-picker content in the middle of the screen stays uncluttered. */
const EXCLUDE_RX_FRAC = 0.15;
const EXCLUDE_RY_FRAC = 0.2;

function randomHomePosition(width: number, height: number): { x: number; y: number } {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * EXCLUDE_RX_FRAC;
  const ry = height * EXCLUDE_RY_FRAC;
  // Rejection-sample a random point until it lands outside the excluded ellipse
  // (bounded attempts so we can never spin forever on a pathologically tiny window).
  for (let attempt = 0; attempt < 25; attempt++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    if (nx * nx + ny * ny >= 1) return { x, y };
  }
  // Fallback: force a point along the ellipse's outer edge in a random direction.
  const angle = Math.random() * Math.PI * 2;
  return { x: cx + Math.cos(angle) * rx * 1.15, y: cy + Math.sin(angle) * ry * 1.15 };
}

function makeParticle(width: number, height: number): Particle {
  const { x, y } = randomHomePosition(width, height);
  const depth = 0.2 + Math.random() * 0.8;
  return {
    depth,
    homeX: x,
    homeY: y,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 0.8 + depth * 1.6,
    color: GOLD_SHADES[Math.floor(Math.random() * GOLD_SHADES.length)],
    baseAlpha: 0.25 + depth * 0.45,
    twinkleSpeed: 0.6 + Math.random() * 1.2,
    twinklePhase: Math.random() * Math.PI * 2,
    wanderRadius: 4 + Math.random() * 10,
    wanderSpeed: 0.15 + Math.random() * 0.3,
    wanderPhase: Math.random() * Math.PI * 2,
  };
}

/**
 * A dense field of tiny gold particles drifting around the launch screen, avoiding
 * the center (where the profile cards sit), gently orbiting/jiggling on their own
 * even at rest, and scattering away from the cursor before springing back once it
 * moves away. Pure canvas + requestAnimationFrame - no per-particle DOM nodes, so
 * it stays cheap even with 200+ particles animating continuously.
 */
export default function GoldParticleField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useAppReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (reducedMotion) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }

    let width = window.innerWidth;
    let height = window.innerHeight;
    let particles: Particle[] = [];
    const content = canvas.nextElementSibling;
    let excluded = content?.getBoundingClientRect();
    const measureContent = () => { excluded = content?.getBoundingClientRect(); };
    const observer = new ResizeObserver(measureContent);
    if (content) observer.observe(content);

    const resize = () => {
      const scaleX = window.innerWidth / Math.max(1, width);
      const scaleY = window.innerHeight / Math.max(1, height);
      for (const particle of particles) {
        particle.homeX *= scaleX;
        particle.homeY *= scaleY;
        particle.x *= scaleX;
        particle.y *= scaleY;
      }
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      measureContent();
    };
    resize();

    particles = Array.from({ length: PARTICLE_COUNT }, () => makeParticle(width, height));
    window.addEventListener("resize", resize);

    // Mouse far off-screen by default so nothing repels until the user actually moves it.
    const mouse = { x: -9999, y: -9999 };
    const camera = { x: 0, y: 0, targetX: 0, targetY: 0 };
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      camera.targetX = Math.max(-1, Math.min(1, event.clientX / width * 2 - 1)) * 22;
      camera.targetY = Math.max(-1, Math.min(1, event.clientY / height * 2 - 1)) * 16;
    };
    const handlePointerLeave = () => { mouse.x = -9999; mouse.y = -9999; camera.targetX = 0; camera.targetY = 0; };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("blur", handlePointerLeave);

    let rafId = 0;
    let elapsed = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      if (document.hidden) return;
      const deltaMs = now - lastTime;
      lastTime = now;
      const dt = Math.min(deltaMs / 16.67, 2); // normalize to ~60fps steps, cap for tab-switch gaps
      elapsed += deltaMs;
      camera.x += (camera.targetX - camera.x) * (1 - Math.pow(0.93, dt));
      camera.y += (camera.targetY - camera.y) * (1 - Math.pow(0.93, dt));

      ctx.clearRect(0, 0, width, height);

      for (const p of particles) {
        // Slowly orbiting/jiggling target instead of a fixed point, so particles
        // never sit perfectly still even with no cursor interaction at all.
        const t = elapsed * 0.001 * p.wanderSpeed + p.wanderPhase;
        const targetX = p.homeX + Math.cos(t) * p.wanderRadius + camera.x * p.depth;
        const targetY = p.homeY + Math.sin(t * 1.3) * p.wanderRadius + camera.y * p.depth;

        // Repulsion away from the cursor.
        const dx = p.x - mouse.x;
        const dy = p.y - mouse.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < REPEL_RADIUS * REPEL_RADIUS) {
          const dist = Math.sqrt(distSq) || 0.001;
          const force = (1 - dist / REPEL_RADIUS) * REPEL_STRENGTH / (dist * dist + 400);
          p.vx += (dx / dist) * force * dt;
          p.vy += (dy / dist) * force * dt;
        }

        // Spring pull back toward its (gently moving) resting position.
        p.vx += (targetX - p.x) * SPRING_K * dt;
        p.vy += (targetY - p.y) * SPRING_K * dt;

        // Damping so it settles instead of oscillating forever.
        p.vx *= Math.pow(DAMPING, dt);
        p.vy *= Math.pow(DAMPING, dt);

        p.x += p.vx * dt;
        p.y += p.vy * dt;

        const twinkle = Math.sin(elapsed * 0.001 * p.twinkleSpeed + p.twinklePhase) * 0.25;
        const alpha = Math.max(0.05, Math.min(1, p.baseAlpha + twinkle));

        if (excluded && p.x > excluded.left - 16 && p.x < excluded.right + 16 && p.y > excluded.top - 16 && p.y < excluded.bottom + 16) continue;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
        ctx.fill();
      }

      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    const handleVisibility = () => {
      cancelAnimationFrame(rafId);
      handlePointerLeave();
      lastTime = performance.now();
      if (!document.hidden) rafId = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("blur", handlePointerLeave);
    };
  }, [reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      aria-hidden="true"
    />
  );
}
