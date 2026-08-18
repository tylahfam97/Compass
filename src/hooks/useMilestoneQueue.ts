import { useCallback, useEffect, useState } from "react";
import type { MilestoneEvent } from "@/lib/milestones";

/** Shows milestone celebrations one at a time. Several can be detected in a single load (e.g.
 *  an import that pays off a card AND pushes net worth past $100K), and stacking two confetti
 *  bursts on top of each other reads as a glitch rather than a celebration - so they queue and
 *  play in sequence, each advancing when the previous one is dismissed. */
export function useMilestoneQueue() {
  const [queue, setQueue] = useState<MilestoneEvent[]>([]);
  const [active, setActive] = useState<MilestoneEvent | null>(null);

  useEffect(() => {
    if (active === null && queue.length > 0) {
      setActive(queue[0]);
      setQueue((q) => q.slice(1));
    }
  }, [active, queue]);

  const enqueue = useCallback((events: MilestoneEvent[]) => {
    if (events.length > 0) setQueue((q) => [...q, ...events]);
  }, []);

  const dismiss = useCallback(() => setActive(null), []);

  return { active, enqueue, dismiss };
}
