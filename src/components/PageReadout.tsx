import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useIsDark } from "@/hooks/useIsDark";

/**
 * The reading stays in view. Pages lead with one primary figure (net this month, net worth,
 * safe to spend); on a long page it scrolls away within a screen. Once it has, this repeats
 * the page title and that figure in a slim bar pinned to the top of the workspace, so the
 * number the rest of the page explains is never out of sight.
 *
 * It mirrors what the page already renders rather than recomputing anything: the source is
 * the StatRow hero, or any element marked data-page-reading="<label>". Same text, same colour,
 * same account scope, by construction. Purely visual: hidden from assistive tech (the figure
 * is already on the page) and click-through, so it never intercepts what scrolls beneath it.
 */
const SOURCE = '.workspace-page [data-page-reading], .workspace-page .stat-row-item[data-hero="true"] > strong';

interface Reading { title: string; label: string; value: string; color: string }

export default function PageReadout() {
  const { pathname } = useLocation();
  // The colour is copied from the page as a computed value, so it is read again when the theme
  // changes: nothing under <main> mutates then, and the old theme's colour would stay.
  const dark = useIsDark();
  const [reading, setReading] = useState<Reading | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    let source: Element | null = null;
    let scrolledPast = false;
    let frame = 0;

    const publish = () => {
      frame = 0;
      if (!source || !source.isConnected || !scrolledPast) { setShown(false); return; }
      const next: Reading = {
        title: main.querySelector(".workspace-page h1")?.textContent?.trim() ?? "",
        label: (source.getAttribute("data-page-reading") ?? source.previousElementSibling?.textContent ?? "").trim(),
        value: source.textContent?.trim() ?? "",
        color: getComputedStyle(source).color,
      };
      if (!next.value) { setShown(false); return; }
      setReading((prev) => (prev && prev.title === next.title && prev.label === next.label && prev.value === next.value && prev.color === next.color ? prev : next));
      setShown(true);
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(publish); };
    // A theme switch can sample midway through the source's CSS colour transition.
    const settledColor = (event: TransitionEvent) => {
      if (event.target === source && event.propertyName === "color") schedule();
    };
    main.addEventListener("transitionend", settledColor);

    const visibility = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      scrolledPast = !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
      schedule();
    }, { root: main });

    // Pages load their figures after mounting and count them up, so keep finding the source
    // and following its text.
    const rescan = () => {
      const found = main.querySelector(SOURCE);
      if (found !== source) {
        visibility.disconnect();
        source = found;
        scrolledPast = false;
        if (source) visibility.observe(source);
      }
      schedule();
    };
    const mutations = new MutationObserver(rescan);
    mutations.observe(main, { childList: true, subtree: true, characterData: true });
    rescan();

    return () => {
      main.removeEventListener("transitionend", settledColor);
      mutations.disconnect();
      visibility.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      setShown(false);
    };
  }, [pathname, dark]);

  return (
    <div className="page-readout" data-shown={shown ? "true" : undefined} aria-hidden="true">
      <div className="page-readout-bar">
        <span className="page-readout-title">{reading?.title}</span>
        <span className="page-readout-reading">
          <small>{reading?.label}</small>
          <strong style={{ color: reading?.color }}>{reading?.value}</strong>
        </span>
      </div>
    </div>
  );
}
