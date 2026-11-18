import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "../state/uiStore";
import { effectiveExitMs } from "./motion";

// Only ordinary browse views get a short retained exit. In particular, never keep a second
// Braccato renderer, settings dialog or an active decode tester around for a decorative fade.
const BROWSE = new Set<Route["name"]>(["home", "library", "album", "artist", "history", "stats"]);
const scrollMemory = new Map<string, number>();

type Page = { key: string; route: Route };

function RoutePane({ page, leaving, renderRoute }: {
  page: Page;
  leaving: boolean;
  renderRoute: (route: Route) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const saved = scrollMemory.get(page.key);
    if (!el || !saved) return;
    el.scrollTo({ top: saved, behavior: "instant" });
  }, [page.key]);

  return (
    <div
      ref={ref}
      className="content-scroll"
      inert={leaving}
      aria-hidden={leaving || undefined}
      data-route-exit={leaving || undefined}
      onScroll={leaving ? undefined : event => scrollMemory.set(page.key, event.currentTarget.scrollTop)}
    >
      {renderRoute(page.route)}
    </div>
  );
}

export function RouteViewport({ route, reducedMotion, renderRoute }: {
  route: Route;
  reducedMotion: boolean;
  renderRoute: (route: Route) => ReactNode;
}) {
  // Typing in global search is not a route transition. Library tabs still get independent keys.
  const key = route.name === "search" ? "search" : `${route.name}-${JSON.stringify(route)}`;
  const current = { key, route };
  const [pages, setPages] = useState<{ current: Page; leaving: Page | null }>({ current, leaving: null });
  const showExit = !reducedMotion && !document.hidden;
  if (pages.current.key !== key) {
    setPages({ current, leaving: showExit && BROWSE.has(pages.current.route.name) && BROWSE.has(route.name) ? pages.current : null });
  } else if (!showExit && pages.leaving) {
    setPages({ current, leaving: null });
  }

  const leaving = pages.leaving;
  useLayoutEffect(() => {
    if (!leaving) return;
    const remove = () => setPages(pages => pages.leaving === leaving ? { ...pages, leaving: null } : pages);
    const timer = window.setTimeout(remove, effectiveExitMs());
    const onVisibility = () => { if (document.hidden) remove(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [leaving]);

  return (
    <div className="route-stage">
      {[current, leaving].map(page => page && (
        <RoutePane key={page.key} page={page} leaving={page === leaving} renderRoute={renderRoute} />
      ))}
    </div>
  );
}
