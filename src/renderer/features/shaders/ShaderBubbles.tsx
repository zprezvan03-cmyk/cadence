/**
 * Glassmorphism bubbles for the global shader background. Written for Cadence.
 *
 * A handful of large, soft glass spheres drifting slowly over the shader: each one is a translucent
 * disc with its own backdrop blur, an inner highlight, a rim light and a soft cast shadow, so they
 * read as frosted objects with depth rather than flat circles. They live inside the wallpaper layer —
 * below every piece of UI — and are decorative only.
 *
 * The animation is CSS-only (no timer, no JS per frame): a slow `transform` drift plus a slow
 * `border-radius` morph gives the organic motion, both composited by the browser. Because it is pure
 * CSS inside a layer that only exists while the feature is on, "off" means no bubbles, no animation
 * and no compositing work at all. Reduced motion holds them still.
 */

export interface GlassBubble {
  /** Diameter in viewport-relative units, so the composition scales with the window. */
  size: number;
  /** Position, in percent of the layer. */
  top: number;
  left: number;
  /** Translucency of the glass surface. */
  opacity: number;
  /** Seconds for one drift cycle; different per bubble so the group never pulses in sync. */
  duration: number;
  /** Seconds of delay so the drift starts out of phase. */
  delay: number;
  /** Backdrop blur radius, in pixels. */
  blur: number;
  /** Blob morph, in percent of the disc's own size. */
  morph: number;
  /** Halo colour: a pale tint that reads as light caught inside the glass. */
  tint: string;
}

/**
 * The composition. Kept deliberately sparse: a few large spheres near the edges and one in the lower
 * middle, all low-opacity, so the wallpaper never competes with the text that sits above it. Sizes and
 * offsets are in `vmax`/percent so the layout stays the same shape at every window size.
 */
export const GLASS_BUBBLES: GlassBubble[] = [
  // Top-left, mostly behind the sidebar and the page's top margin.
  { size: 40, top: -14, left: -6, opacity: 0.5, duration: 36, delay: 0, blur: 26, morph: 6, tint: "rgba(255, 255, 255, 0.5)" },
  // Lower left, below the reading column.
  { size: 26, top: 74, left: 2, opacity: 0.36, duration: 44, delay: -9, blur: 22, morph: 8, tint: "rgba(214, 226, 255, 0.45)" },
  // Top right corner, clear of the page heading and the action buttons.
  { size: 20, top: -6, left: 84, opacity: 0.34, duration: 31, delay: -14, blur: 18, morph: 10, tint: "rgba(255, 235, 246, 0.45)" },
  // Right edge, mid height: over the empty gutter of the view, never the rows.
  { size: 30, top: 44, left: 88, opacity: 0.3, duration: 47, delay: -5, blur: 30, morph: 7, tint: "rgba(226, 236, 255, 0.4)" },
  // A small one high in the gutter between the sidebar and the content.
  { size: 12, top: 20, left: 16, opacity: 0.28, duration: 27, delay: -19, blur: 12, morph: 12, tint: "rgba(255, 255, 255, 0.55)" },
  // Bottom right, under the player bar's shade.
  { size: 16, top: 82, left: 76, opacity: 0.26, duration: 38, delay: -23, blur: 16, morph: 9, tint: "rgba(255, 245, 232, 0.45)" },
];

export function ShaderBubbles() {
  return (
    <div className="global-shader-bubbles" aria-hidden="true">
      {GLASS_BUBBLES.map((bubble, index) => (
        <span
          key={index}
          className="glass-bubble"
          style={
            {
              "--bubble-size": `${bubble.size}vmax`,
              "--bubble-top": `${bubble.top}%`,
              "--bubble-left": `${bubble.left}%`,
              "--bubble-opacity": bubble.opacity,
              "--bubble-duration": `${bubble.duration}s`,
              "--bubble-delay": `${bubble.delay}s`,
              "--bubble-blur": `${bubble.blur}px`,
              "--bubble-morph": `${bubble.morph}%`,
              "--bubble-tint": bubble.tint,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
