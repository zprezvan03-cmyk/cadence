import type { Page } from "puppeteer-core";

type Check = (name: string, passed: boolean, detail?: string) => void;
type Shot = (name: string) => Promise<unknown>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const click = (page: Page, selector: string) => page.evaluate(sel => document.querySelector<HTMLElement>(sel)!.click(), selector);
const getBox = (page: Page, selector: string) => page.$eval(selector, el => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
const visibleTransport = '.player-bar [data-testid="play-toggle"], .mini-player [data-testid="play-toggle"]';
const next = '.player-bar button[aria-label="Next track"]';
const hero = '.np-window-cover .playback-cover';
const coverInFlight = '[data-player-flight="artwork"]';
const mini = '[data-testid="mini-player"]';
const toggle = '[data-testid="open-mini-player"]';
const expand = '[data-testid="mini-expand"]';
const openNow = '.mini-player-artwork';
const currentCover = '.player-bar [data-cover-layer="current"]';
const currentTitle = '.player-bar [data-track-layer="current"] .player-title';

function titleIs(page: Page, title: string) {
  return page.waitForFunction((sel, text) => document.querySelector(sel)?.textContent?.includes(text), { timeout: 3000 }, currentTitle, title);
}
function hasCover(page: Page, file: string) {
  return page.waitForFunction((sel, name) => {
    const img = document.querySelector<HTMLImageElement>(`${sel} img`);
    return img?.src.endsWith(name) && img.complete && img.naturalWidth > 0;
  }, { timeout: 3000 }, currentCover, file);
}
function finish(page: Page, animationId: string) {
  return page.evaluate(prefix => document.getAnimations().filter(anim => anim.id.startsWith(prefix)).forEach(anim => anim.finish()), animationId);
}

export async function auditArtworkResilience(page: Page, check: Check, shot: Shot) {
  await page.evaluate(() => {
    const original = HTMLImageElement.prototype.decode;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host = window as Window & { releaseCover?: () => void; repeatedCoverDecodes?: number };
    host.repeatedCoverDecodes = 0;
    // Hold only the next valid cover, including if its bytes are already in the browser cache.
    HTMLImageElement.prototype.decode = async function () {
      if (this.src.endsWith("/blue.png")) host.repeatedCoverDecodes!++;
      await original.call(this);
      if (this.src.endsWith("/slow.png")) await gate;
    };
    host.releaseCover = release;
    window.addEventListener("cadence-artwork-audit-done", () => { HTMLImageElement.prototype.decode = original; }, { once: true });
  });
  await click(page, next);
  await titleIs(page, "Canopy");
  const pending = await page.$eval(currentCover, el => el.querySelector("img")?.src);
  check("slow-decode-does-not-blank-cover-or-delay-metadata", pending?.endsWith("/blue.png") === true, pending);
  await shot("02-slow-cover-held");

  // Skip past the delayed decode, through a genuinely corrupt image and to a cached URL.
  // Sample every commit, not just the settled frame, to catch mounted-layer leaks.
  const maxLayers = await page.evaluate(async () => {
    let max = 0;
    let min = Infinity;
    const measure = () => {
      const count = document.querySelectorAll(".player-bar [data-cover-layer]").length;
      max = Math.max(max, count);
      min = Math.min(min, count);
    };
    const observer = new MutationObserver(measure);
    observer.observe(document.querySelector(".player-bar")!, { subtree: true, childList: true });
    const nextButton = document.querySelector<HTMLButtonElement>('.player-bar button[aria-label="Next track"]')!;
    nextButton.click();
    await new Promise(done => setTimeout(done, 34));
    nextButton.click();
    (window as Window & { releaseCover?: () => void }).releaseCover?.();
    await new Promise(done => setTimeout(done, 420));
    observer.disconnect();
    return { min, max };
  });
  await titleIs(page, "Evening");
  await hasCover(page, "blue.png");
  check("rapid-skips-keep-bounded-overlap-and-ignore-stale-decode", maxLayers.min >= 1 && maxLayers.max <= 2, JSON.stringify(maxLayers));

  await click(page, '.player-bar button[aria-label="Previous track"]');
  await titleIs(page, "Dusk");
  await page.waitForFunction(sel => !document.querySelector(`${sel} img`) && !document.querySelector('.player-bar [data-cover-layer="outgoing"]'), { timeout: 3000 }, currentCover);
  check("failed-decode-settles-to-fallback", Boolean(await page.$(`${currentCover} .artwork-fallback-icon`)));
  await click(page, next);
  await titleIs(page, "Evening");
  await hasCover(page, "blue.png");
  const redecode = await page.evaluate(() => {
    window.dispatchEvent(new Event("cadence-artwork-audit-done"));
    return (window as Window & { repeatedCoverDecodes?: number }).repeatedCoverDecodes;
  });
  check("repeat-cover-url-reuses-readiness", redecode === 0, `extra decodes: ${redecode}`);
  await wait(380);
}

export async function auditQueueRows(page: Page, check: Check, shot: Shot) {
  const rowSelector = ".queue-list > li";
  const rows = () => page.$$eval(rowSelector, nodes => nodes.map(node => (node as HTMLElement).dataset.occurrenceId!));
  const animations = () => page.evaluate(() => document.getAnimations().map(animation => animation.id).filter(id => id.startsWith("queue-row")));
  const before = await rows();
  // Remove a visible occurrence without stopping playback, then reinsert that track using the
  // real Play Next action. The new occurrence must be a new key even if its source is repeated.
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.queue-list > li:first-child > button[aria-label^="Remove"]')!.click());
  const exited = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(".queue-motion-exits");
    const ids = document.getAnimations().filter(animation => animation.id.startsWith("queue-row"));
    ids.forEach(animation => { animation.pause(); animation.currentTime = 54; });
    return { inert: wrapper?.inert, hidden: wrapper?.getAttribute("aria-hidden"), animations: ids.map(animation => animation.id) };
  });
  const removed = await rows();
  check("queue-removal-is-immediate-with-inert-exit-and-visible-flip", removed.length === before.length - 1 && !removed.includes(before[0]) && exited.inert === true && exited.hidden === "true" && exited.animations.includes("queue-row-out") && exited.animations.includes("queue-row-move"), JSON.stringify(exited));
  await shot("03-queue-removal-mid");
  await finish(page, "queue-row");

  // Start at the first occurrence so Play Next inserts inside the visible window.
  await click(page, ".queue-list > li:first-child .queue-track");
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('.track-row:first-of-type button[aria-label="More actions"]')?.click());
  if (!(await page.$(".context-menu"))) await click(page, '.track-row button[aria-label="More actions"]');
  await page.waitForSelector(".context-menu button");
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".context-menu button")].find(node => node.textContent?.includes("Play next"))!.click());
  const inserted = await rows();
  const insertAnimations = await animations();
  check("queue-insert-keeps-occurrence-identity", inserted.length === removed.length + 1 && inserted.filter(id => !removed.includes(id)).length === 1 && insertAnimations.includes("queue-row-in"), JSON.stringify(insertAnimations));
  await wait(260);
  await click(page, '.player-bar [aria-label="Shuffle"]');
  const shuffled = await rows();
  const shuffleAnimations = await animations();
  check("queue-reorder-animates-visible-rows-only", shuffled.join() !== inserted.join() && shuffled.every(id => inserted.includes(id)) && shuffleAnimations.includes("queue-row-move") && shuffleAnimations.length <= 24, JSON.stringify(shuffleAnimations));
  await click(page, '.player-bar [aria-label="Shuffle"]');
  await wait(270);
  check("queue-flip-cleans-up-after-rapid-orders", (await animations()).length === 0 && !(await page.$(".queue-motion-exits")));
}

type LyricsHost = HTMLElement & { mediaElement: HTMLMediaElement | null; tickOptions: { smoothScroll?: boolean }; currentTime: number };
const host = "braccato-lyrics";
async function seekLyric(page: Page, seconds: number, line: string) {
  await page.$eval(host, (el, time) => {
    const media = (el as LyricsHost).mediaElement!;
    media.pause();
    media.currentTime = time;
  }, seconds);
  await page.waitForFunction(expected => document.querySelector("braccato-lyrics .blyrics--active")?.textContent?.includes(expected), { timeout: 2500 }, line);
}
export async function auditLyricFollow(page: Page, check: Check, shot: Shot) {
  await page.waitForFunction(() => Boolean((document.querySelector("braccato-lyrics") as LyricsHost | null)?.mediaElement && document.querySelector(".blyrics--line")), { timeout: 5000 });
  await seekLyric(page, 2.02, "Second line");
  await wait(300);
  const follow = await page.$eval(host, async el => {
    const media = (el as LyricsHost).mediaElement!;
    const line = [...el.querySelectorAll(".blyrics--line")].find(node => node.textContent?.includes("Third line"))!;
    const start = line.getBoundingClientRect().y;
    const targets = new Set<number>([Math.round(start)]);
    const durations = new Set<number>();
    let thirdWasActive = false;
    await media.play();
    const deadline = performance.now() + 4000;
    // Stop against the media clock, not a wall-clock delay that can overshoot to line four
    // when a busy CI browser misses frames. All sampled motion is natural playback, not a seek.
    do {
      await new Promise(done => requestAnimationFrame(done));
      targets.add(Math.round(line.getBoundingClientRect().y));
      thirdWasActive ||= line.classList.contains("blyrics--active");
      for (const animation of line.getAnimations()) {
        const effect = animation.effect as KeyframeEffect | null;
        if (effect?.getKeyframes().some(frame => frame.translate)) durations.add(Number(effect.getTiming().duration));
      }
    } while (media.currentTime < 3.9 && performance.now() < deadline && !media.paused);
    media.pause();
    return { start, end: line.getBoundingClientRect().y, positions: targets.size, durations: [...durations], thirdWasActive, time: media.currentTime };
  });
  check("lyric-follow-travels-and-uses-240ms-compensation", follow.positions >= 3 && follow.end < follow.start - 15 && follow.durations.includes(240) && follow.thirdWasActive, JSON.stringify(follow));
  await seekLyric(page, 0.65, "First line");
  await wait(260);
  await seekLyric(page, 4.85, "Fourth line");
  const seek = await page.$eval(host, el => {
    const settle = el.getAnimations().find(animation => animation.id === "lyrics-seek-settle");
    settle?.pause();
    if (settle) settle.currentTime = 60;
    return { opacity: Number(getComputedStyle(el).opacity), time: (el as LyricsHost).currentTime, hosts: document.querySelectorAll("braccato-lyrics").length };
  });
  check("long-lyric-seek-lands-on-clock-then-settles", seek.time === 4.85 && seek.hosts === 1 && seek.opacity > 0.58 && seek.opacity < 1, JSON.stringify(seek));
  await shot("05-lyrics-long-seek-mid");
  await finish(page, "lyrics-seek-settle");
}

export async function auditMiniHandoff(page: Page, check: Check, shot: Shot) {
  await page.waitForSelector(hero, { timeout: 3000 });
  await wait(410);
  const fullArt = await getBox(page, hero);
  await click(page, toggle);
  await page.waitForSelector(mini);
  await wait(420);
  const miniArt = await getBox(page, ".mini-player .playback-cover");
  const miniTransport = await getBox(page, visibleTransport);
  const before = await page.$eval(".mini-player .seek", el => Number((el as HTMLInputElement).value));
  await shot("11-mini-settled");

  await click(page, openNow);
  await page.waitForSelector(coverInFlight, { timeout: 3000 });
  const handoff = await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      // Only freeze scene motion; a clock or highlight is never changed by this probe.
      if (animation.effect?.getTiming().duration !== 380 && animation.id !== "player-surroundings") continue;
      animation.pause();
      animation.currentTime = 70;
    }
    const flight = document.querySelector<HTMLElement>(".player-flight")!;
    const cover = flight.querySelector('[data-player-flight="artwork"]')!;
    const play = document.querySelector('.player-bar [data-testid="play-toggle"]')!;
    return {
      art: cover.getBoundingClientRect().toJSON(),
      transport: play.getBoundingClientRect().toJSON(),
      meta: Boolean(flight.querySelector('[data-player-flight="metadata"]')),
      inert: flight.inert,
      playTargets: document.querySelectorAll('[data-testid="play-toggle"]').length,
      nowPlaying: Boolean(document.querySelector('.lyrics-view:not(.is-fullscreen)')),
      seekTime: Number(document.querySelector<HTMLInputElement>(".player-bar .seek")!.value),
    };
  });
  check("mini-expands-cover-metadata-and-live-transport", handoff.nowPlaying && handoff.meta && handoff.inert && handoff.playTargets === 1 && Math.abs(handoff.seekTime - before) < 0.08 && handoff.art.width > miniArt.width + 3 && handoff.art.width < fullArt.width - 3 && handoff.transport.y > miniTransport.y + 30, JSON.stringify(handoff));
  await shot("11-mini-expand-mid");
  // Hit the *moving* play button with a pointer while the animation is held.
  await page.mouse.click(handoff.transport.x + handoff.transport.width / 2, handoff.transport.y + handoff.transport.height / 2);
  const played = await page.waitForFunction(() => document.querySelector('.player-bar [data-testid="play-toggle"]')?.getAttribute("aria-label") === "Pause", { timeout: 2500 }).then(() => true).catch(() => false);
  check("mini-live-transport-works-in-flight", played);
  if (played) await click(page, visibleTransport);
  await page.keyboard.press("q");
  await page.waitForSelector(".queue-panel");
  const overlay = await page.evaluate(() => {
    const queue = document.querySelector(".queue-panel")!;
    const flight = document.querySelector(".player-flight")!;
    return {
      above: Number(getComputedStyle(queue).zIndex) > Number(getComputedStyle(flight).zIndex),
      flightEvents: getComputedStyle(flight).pointerEvents,
    };
  });
  check("queue-can-open-above-a-live-handoff", overlay.above && overlay.flightEvents === "none", JSON.stringify(overlay));
  await click(page, '.queue-panel button[aria-label="Close queue"]');
  await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "paused").forEach(animation => animation.finish()));
  await wait(420);
  check("mini-handoff-removes-overlays", !(await page.$(".player-flight, [data-in-flight]")));
  await shot("11-mini-expand-settled");

  // Interrupt the reverse transition, sampling the exact displayed position before expanding
  // again. No new flight should start back at either of its original endpoints.
  await click(page, toggle);
  await page.waitForSelector(coverInFlight);
  const reversal = await page.evaluate(async () => {
    const covers = () => [...document.querySelectorAll('[data-player-flight="artwork"]')];
    for (const anim of document.getAnimations()) {
      if (anim.effect?.getTiming().duration !== 380) continue;
      anim.pause();
      anim.currentTime = 77;
    }
    const before = covers()[0].getBoundingClientRect().toJSON();
    document.querySelector<HTMLButtonElement>('.mini-player-artwork')!.click();
    await new Promise(done => requestAnimationFrame(done));
    const after = covers()[0]?.getBoundingClientRect().toJSON();
    return { before, after };
  });
  check("mini-rapid-reversal-starts-at-displayed-geometry", Boolean(reversal.after && Math.abs(reversal.before.x - reversal.after.x) < 35 && Math.abs(reversal.before.width - reversal.after.width) < 24), JSON.stringify(reversal));
  await page.setViewport({ width: 1050, height: 700 });
  await page.waitForFunction(() => !document.querySelector(".player-flight, [data-in-flight]"), { timeout: 1500 });
  const resized = await getBox(page, hero);
  check("mini-resize-cancels-flight-within-responsive-layout", resized.width > miniArt.width && resized.x + resized.width < 1050, JSON.stringify(resized));
  await page.setViewport({ width: 1440, height: 900 });

  // Run against the same production hook with a bridge that delivers asynchronous viewport sizes.
  const nativeCalls: boolean[] = [];
  await page.exposeFunction("resizeMiniForAudit", async (compact: boolean) => {
    nativeCalls.push(compact);
    await page.setViewport(compact ? { width: 460, height: 160 } : { width: 1440, height: 900 });
  });
  await page.evaluate(() => {
    const native = (window as unknown as { resizeMiniForAudit: (compact: boolean) => Promise<void> }).resizeMiniForAudit;
    window.cadence!.app.setMiniPlayer = native;
    document.querySelector<HTMLButtonElement>('.nav-item[title="Songs"]')!.click();
  });
  await wait(260);
  // Reverse before the delayed shrink starts. There must be no redundant native restore.
  await click(page, toggle);
  await page.waitForSelector(mini);
  await click(page, expand);
  await page.waitForSelector('.library-view', { timeout: 3000 });
  await wait(420);
  check("rapid-mini-return-does-not-resize-native-window", nativeCalls.length === 0);
  await click(page, toggle);
  await page.waitForSelector(mini);
  const nativeHeld = await page.evaluate(() => window.innerWidth === 1440 && Boolean(document.querySelector(".player-flight")));
  await page.waitForFunction(() => window.innerWidth === 460 && !document.querySelector(".player-flight"), { timeout: 3000 });
  await click(page, expand);
  await page.waitForSelector('.library-view', { timeout: 3000 });
  const nativeRestored = await page.evaluate(() => window.innerWidth === 1440 && Boolean(document.querySelector('.player-bar')) && !document.querySelector('.lyrics-view'));
  check("native-resize-is-sequenced-and-restore-keeps-route", nativeHeld && nativeRestored && nativeCalls.join() === "true,false", JSON.stringify({ nativeHeld, nativeRestored, nativeCalls }));
  await wait(420);
  await page.evaluate(() => { Reflect.deleteProperty(window.cadence!.app, "setMiniPlayer"); });

  // Live OS preference, without a reload. Art still reaches Now Playing without a flight and
  // Braccato remains bound: only interpolated scrolling and decorative movement are disabled.
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await click(page, toggle);
  await page.waitForSelector(mini);
  await click(page, openNow);
  await page.waitForSelector(hero);
  const reduced = await page.$eval(host, el => ({
    flight: Boolean(document.querySelector(".player-flight, [data-in-flight]")),
    plays: Boolean((el as LyricsHost).mediaElement),
    smooth: (el as LyricsHost).tickOptions.smoothScroll,
    swipe: getComputedStyle(el.querySelector(".blyrics-container")!).getPropertyValue("--blyrics-animate-highlight-swipe").trim(),
  }));
  check("mini-and-lyrics-respect-live-reduced-motion", !reduced.flight && reduced.plays && reduced.smooth === false && reduced.swipe === "1", JSON.stringify(reduced));
  await page.emulateMediaFeatures([]);

  // A real profile with hidden art uses the persistent player-bar target, not a fake hero.
  await click(page, '[data-testid="customize-now-playing"]');
  await page.waitForSelector('[data-testid="studio-duplicate"]');
  await click(page, '[data-testid="studio-duplicate"]');
  await click(page, '.np-studio input[aria-label="Show artwork"]');
  await click(page, '[data-testid="studio-save"]');
  await page.waitForSelector('.lyrics-view[data-profile-artwork="hidden"]');
  await wait(200);
  await click(page, toggle);
  await page.waitForSelector(mini);
  await wait(410);
  await click(page, openNow);
  await page.waitForSelector('.lyrics-view[data-profile-artwork="hidden"]');
  const fallback = await page.evaluate(() => ({
    hidden: !document.querySelector(".np-window-cover"),
    barTarget: Boolean(document.querySelector('.player-bar .playback-cover[data-in-flight]')),
    hosts: document.querySelectorAll("braccato-lyrics").length,
  }));
  check("mini-handoff-respects-hidden-art-profile", fallback.hidden && fallback.barTarget && fallback.hosts === 1, JSON.stringify(fallback));
  await wait(405);
}
