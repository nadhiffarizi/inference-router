import { useEffect, useState } from "react";

/**
 * Minimal history-API router: real paths (/playground, /keys, …) with no
 * router dependency. The shell renders by pathname, so a refresh or a
 * shared deep link lands on the same menu (gateway rewrites unknown paths
 * to index.html).
 */

const ROUTE_EVENT = "route:change";

export function navigate(to: string, replace = false): void {
  if (window.location.pathname === to) return;
  if (replace) window.history.replaceState({}, "", to);
  else window.history.pushState({}, "", to);
  // pushState/replaceState fire no event — tell active subscribers ourselves.
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const wake = () => setPath(window.location.pathname);
    window.addEventListener("popstate", wake);
    window.addEventListener(ROUTE_EVENT, wake);
    return () => {
      window.removeEventListener("popstate", wake);
      window.removeEventListener(ROUTE_EVENT, wake);
    };
  }, []);
  return path;
}

/** `<a>` that routes in-app instead of a full page load. */
export function linkProps(href: string): {
  href: string;
  onClick: (e: React.MouseEvent<HTMLAnchorElement>) => void;
} {
  return {
    href,
    onClick: (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      e.preventDefault();
      navigate(href);
    },
  };
}