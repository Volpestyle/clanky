import { useEffect, useRef, useState, useCallback } from "react";

export function useActiveSection(ids: readonly string[]) {
  const [activeId, setActiveId] = useState(ids[0] || "");
  const isClickScrolling = useRef(false);
  const scrollTimeout = useRef<number | null>(null);
  const rafId = useRef(0);
  const scheduleUpdateRef = useRef<() => void>(() => { });

  useEffect(() => {
    function update() {
      if (isClickScrolling.current) return;

      let best = ids[0] || "";
      let foundVisibleSection = false;

      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0) continue;
        foundVisibleSection = true;

        // An element is "active" if it is the first section from the top
        // that is still substantially visible. The threshold scales with height
        // to flawlessly handle very small sections without being prematurely overridden.
        const threshold = Math.min(100, Math.max(10, rect.height * 0.3));
        if (rect.bottom > threshold) {
          best = id;
          break;
        }
      }

      if (!foundVisibleSection) return;
      setActiveId(best);
    }

    function scheduleUpdate() {
      cancelAnimationFrame(rafId.current);
      rafId.current = requestAnimationFrame(update);
    }

    scheduleUpdateRef.current = scheduleUpdate;
    document.addEventListener("scroll", scheduleUpdate, { passive: true, capture: true });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    // Run once so the sidebar is correct on first render / tab switch.
    scheduleUpdate();

    return () => {
      document.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      cancelAnimationFrame(rafId.current);
    };
  }, [ids]);

  const setClickedId = useCallback((id: string) => {
    setActiveId(id);
    isClickScrolling.current = true;

    if (scrollTimeout.current) {
      window.clearTimeout(scrollTimeout.current);
    }

    scrollTimeout.current = window.setTimeout(() => {
      isClickScrolling.current = false;
      scheduleUpdateRef.current();
    }, 800);
  }, []);

  useEffect(() => {
    return () => {
      if (scrollTimeout.current) {
        window.clearTimeout(scrollTimeout.current);
      }
    };
  }, []);

  return { activeId, setClickedId };
}
