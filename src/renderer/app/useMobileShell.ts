/**
 * Responsive shell detection for Android and narrow phone-sized viewports.
 * Desktop viewports (including narrow browser audit suites like 460x160 and
 * 700x900) keep the desktop layout unless the app is running inside the native
 * Android shell or at a real phone portrait viewport. Written for Cadence.
 */

import { useEffect, useState } from "react";
import { isAndroidNativeAudio } from "../audio/androidAudio";
import { useUi } from "../state/uiStore";

export function computeIsMobileLayout(
  width: number,
  height: number,
  miniPlayer: boolean,
  forceAndroid = isAndroidNativeAudio()
): boolean {
  if (miniPlayer) return false;
  if (forceAndroid) return true;
  return width <= 640 && height >= 450;
}

export function useMobileShell(): boolean {
  const miniPlayer = useUi(state => state.miniPlayer);
  const [viewport, setViewport] = useState(() => ({
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));

  useEffect(() => {
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const isMobile = computeIsMobileLayout(viewport.width, viewport.height, miniPlayer);

  useEffect(() => {
    document.documentElement.dataset.mobile = isMobile ? "true" : "false";
    return () => {
      delete document.documentElement.dataset.mobile;
    };
  }, [isMobile]);

  return isMobile;
}
