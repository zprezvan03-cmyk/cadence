import type { Page } from "puppeteer-core";

type Check = (name: string, passed: boolean, detail?: string) => void;
type Shot = (name: string) => Promise<unknown>;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const click = (page: Page, selector: string) => page.evaluate(sel => document.querySelector<HTMLElement>(sel)!.click(), selector);
const getBox = (page: Page, selector: string) => page.$eval(selector, el => el.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number });
const visibleTransport = '.player-bar [data-testid="play-toggle"], .mini-player [data-testid="play-toggle"]';
const next = '.player-bar button[aria-label="Next track"]';
const barCover = ".player-bar .playback-cover";
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
    let slowDecodes = 0;
    // Hold only the next valid cover, including if its bytes are already in the browser cache.
    HTMLImageElement.prototype.decode = async function () {
      if (this.src.endsWith("/blue.png")) host.repeatedCoverDecodes!++;
      if (this.src.endsWith("/slow.png")) slowDecodes++;
      await original.call(this);
      if (this.src.endsWith("/slow.png")) await gate;
    };
    host.releaseCover = release;
    window.addEventListener("cadence-artwork-audit-done", () => { HTMLImageElement.prototype.decode = original; }, { once: true });
    document.addEventListener("cadence-count-slow-cover-decodes", () => {
      document.documentElement.dataset.slowDecodes = String(slowDecodes);
    }, { once: true });
  });
  await click(page, next);
  await titleIs(page, "Canopy");
  const pending = await page.$eval(currentCover, el => el.querySelector("img")?.src);
  check("slow-decode-does-not-blank-cover-or-delay-metadata", pending?.endsWith("/blue.png") === true, pending);
  await shot("02-slow-cover-held");

  // A layout switch must carry the held art too, and join rather than restart the decode.
  await click(page, toggle);
  await page.waitForSelector(mini);
  const compactCover = await page.$eval('.mini-player [data-cover-layer="current"]', el => el.querySelector("img")?.src);
  await click(page, openNow);
  await page.waitForSelector(".lyrics-view");
  const restoredCover = await page.$eval(currentCover, el => el.querySelector("img")?.src);
  const slowDecodes = await page.evaluate(() => {
    document.dispatchEvent(new Event("cadence-count-slow-cover-decodes"));
    const count = document.documentElement.dataset.slowDecodes;
    delete document.documentElement.dataset.slowDecodes;
    return count;
  });
  check("layout-switch-keeps-held-art-and-shares-pending-decode", Boolean(pending && compactCover === pending && restoredCover === pending && slowDecodes === "1"), JSON.stringify({ compactCover, restoredCover, slowDecodes }));
  await click(page, '.nav-item[title="Songs"]');
  await page.waitForSelector(".library-view");

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
  const rowSelector = ".queue-list > li[data-occurrence-id]";
  const rows = () => page.$$eval(rowSelector, nodes => nodes.map(node => (node as HTMLElement).dataset.occurrenceId!));
  const animations = () => page.evaluate(() => document.getAnimations().map(animation => animation.id).filter(id => id.startsWith("queue-row")));
  const before = await rows();
  // Remove a visible occurrence without stopping playback, then reinsert that track using the
  // real Play Next action. The new occurrence must be a new key even if its source is repeated.
  await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('.queue-list > li:first-child')!;
    (window as Window & { removedRow?: HTMLElement }).removedRow = row;
    row.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!.click();
  });
  const exited = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(".queue-row-exits [data-queue-exiting]");
    const ids = document.getAnimations().filter(animation => animation.id.startsWith("queue-row"));
    ids.forEach(animation => { animation.pause(); animation.currentTime = 54; });
    const host = window as Window & { removedRow?: HTMLElement };
    const reused = wrapper === host.removedRow;
    delete host.removedRow;
    return { inert: wrapper?.inert, hidden: wrapper?.getAttribute("aria-hidden"), reused, animations: ids.map(animation => animation.id) };
  });
  const removed = await rows();
  check("queue-removal-is-immediate-with-inert-exit-and-visible-flip", removed.length === before.length - 1 && !removed.includes(before[0]) && exited.inert === true && exited.hidden === "true" && exited.reused && exited.animations.includes("queue-row-out") && exited.animations.includes("queue-row-move"), JSON.stringify(exited));
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
  const insertion = await page.evaluate(() => {
    const active = document.getAnimations().filter(animation => animation.id.startsWith("queue-row"));
    const entry = active.find(animation => animation.id === "queue-row-in");
    if (!entry) return null;
    for (const animation of active) { animation.pause(); animation.currentTime = 80; }
    const effect = entry.effect as KeyframeEffect;
    const row = effect.target as HTMLElement;
    return { opacity: Number(getComputedStyle(row).opacity), duration: effect.getTiming().duration };
  });
  check("queue-insert-keeps-occurrence-identity", inserted.length === removed.length + 1 && inserted.filter(id => !removed.includes(id)).length === 1 && insertAnimations.includes("queue-row-in"), JSON.stringify(insertAnimations));
  check("queue-insert-has-intermediate-enter-frame", insertion?.duration === 180 && insertion.opacity > 0 && insertion.opacity < 1, JSON.stringify(insertion));
  await shot("03-queue-insert-mid");
  await finish(page, "queue-row");
  await wait(50);
  await click(page, '.player-bar [aria-label="Shuffle"]');
  const shuffled = await rows();
  const shuffleAnimations = await animations();
  check("queue-reorder-animates-visible-rows-only", shuffled.join() !== inserted.join() && shuffled.every(id => inserted.includes(id)) && shuffleAnimations.includes("queue-row-move") && shuffleAnimations.length <= 16, JSON.stringify(shuffleAnimations));
  await click(page, '.player-bar [aria-label="Shuffle"]');
  await wait(270);
  check("queue-flip-cleans-up-after-rapid-orders", (await animations()).length === 0 && !(await page.$(".queue-row-exits [data-queue-exiting]")));
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
  await shot("06-lyric-follow-start");
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
  await shot("06-lyric-follow-end");
  await seekLyric(page, 0.65, "First line");
  await wait(260);
  await seekLyric(page, 4.85, "Fourth line");
  const seek = await page.$eval(host, el => ({
    time: (el as LyricsHost).currentTime,
    hosts: document.querySelectorAll("braccato-lyrics").length,
    extra: el.getAnimations().some(animation => animation.id === "lyrics-seek-settle"),
  }));
  check("lyric-seek-retains-clock-without-a-decorative-host-effect", seek.time === 4.85 && seek.hosts === 1 && !seek.extra, JSON.stringify(seek));
}

function waitForFlight(page: Page) {
  return page.waitForFunction(() => document.getAnimations().some(animation => animation.id === "player-artwork-handoff"), { timeout: 3000 });
}

export async function auditMiniHandoff(page: Page, check: Check, shot: Shot) {
  await page.waitForSelector(barCover, { timeout: 3000 });
  await wait(320);
  const full = await getBox(page, barCover);
  await click(page, toggle);
  await page.waitForSelector(mini);
  await waitForFlight(page);
  const collapse = await page.evaluate(() => {
    const animations = document.getAnimations().filter(animation => animation.id.endsWith("-handoff"));
    for (const animation of animations) { animation.pause(); animation.currentTime = 95; }
    const art = document.querySelector(".mini-player-artwork")!;
    const r = art.getBoundingClientRect();
    const clickable = art.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    return { y: r.y, clickable, durations: animations.map(animation => animation.effect?.getTiming().duration) };
  });
  await shot("11-mini-collapse-mid");
  await finish(page, "player-");
  const compact = await getBox(page, ".mini-player .playback-cover");
  const miniTransport = await getBox(page, visibleTransport);
  check("mini-collapse-has-a-live-intermediate-frame", collapse.y < full.y - 15 && collapse.y > compact.y + 15 && collapse.clickable &&
    collapse.durations.length === 3 && collapse.durations.every(duration => duration === 300), JSON.stringify(collapse));
  const before = await page.$eval(".mini-player .seek", el => Number((el as HTMLInputElement).value));
  await shot("11-mini-settled");

  await click(page, openNow);
  await waitForFlight(page);
  const handoff = await page.evaluate(() => {
    const animations = document.getAnimations().filter(animation => animation.id.endsWith("-handoff"));
    for (const animation of animations) { animation.pause(); animation.currentTime = 73; }
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON();
    const art = document.querySelector(".player-bar .playback-cover")!;
    const r = art.getBoundingClientRect();
    return {
      art: r.toJSON(),
      artworkUnobscured: art.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      title: box('.player-bar [data-track-layer="current"] .player-title'),
      transport: box('.player-bar [data-testid="play-toggle"]'),
      names: animations.map(animation => animation.id),
      duplicate: Boolean(document.querySelector(".player-flight, .lyrics-header .artwork, .np-kicker")),
      playTargets: document.querySelectorAll('[data-testid="play-toggle"]').length,
      nowPlaying: Boolean(document.querySelector('.lyrics-view:not(.is-fullscreen)')),
      seekTime: Number(document.querySelector<HTMLInputElement>(".player-bar .seek")!.value),
    };
  });
  check("mini-moves-existing-cover-title-and-live-transport", handoff.nowPlaying && !handoff.duplicate && handoff.artworkUnobscured && handoff.playTargets === 1 &&
    ["artwork", "metadata", "transport"].every(part => handoff.names.includes(`player-${part}-handoff`)) &&
    Math.abs(handoff.seekTime - before) < 0.08 && handoff.art.y > compact.y + 15 && handoff.art.y < full.y - 15 &&
    Math.abs(handoff.art.width - full.width) < 1 && Math.abs(handoff.title.y - handoff.art.y) < handoff.art.height &&
    handoff.transport.y > miniTransport.y + 15, JSON.stringify(handoff));
  await shot("11-mini-expand-mid");
  await page.mouse.click(handoff.transport.x + handoff.transport.width / 2, handoff.transport.y + handoff.transport.height / 2);
  const played = await page.waitForFunction(() => document.querySelector('.player-bar [data-testid="play-toggle"]')?.getAttribute("aria-label") === "Pause", { timeout: 2500 }).then(() => true).catch(() => false);
  check("mini-live-transport-works-in-flight", played);
  if (played) await click(page, visibleTransport);
  await page.keyboard.press("q");
  await page.waitForSelector(".queue-panel");
  const above = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".queue-panel")!).zIndex) >
    Number(getComputedStyle(document.querySelector(".player-bar")!).zIndex));
  check("queue-can-open-above-a-live-handoff", above);
  await click(page, '.queue-panel button[aria-label="Close queue"]');
  await finish(page, "player-");
  await wait(360);
  const landed = await getBox(page, barCover);
  check("mini-handoff-lands-in-existing-player-bar", Math.abs(landed.y - full.y) < 1 && !(await page.$(".player-flight, [data-player-moving]")), JSON.stringify(landed));
  await shot("11-mini-expand-settled");

  // A rapid reversal starts from the displayed geometry of the real, moving artwork.
  await click(page, toggle);
  await waitForFlight(page);
  const reversal = await page.evaluate(async () => {
    const artwork = () => document.getAnimations().find(anim => anim.id === "player-artwork-handoff")!;
    const rect = () => ((artwork().effect as KeyframeEffect).target as Element).getBoundingClientRect().toJSON();
    for (const anim of document.getAnimations()) {
      if (!anim.id.endsWith("-handoff")) continue;
      anim.pause();
      anim.currentTime = 70;
    }
    const before = rect();
    document.querySelector<HTMLButtonElement>('.mini-player-artwork')!.click();
    await new Promise(done => requestAnimationFrame(done));
    return { before, after: rect() };
  });
  check("mini-rapid-reversal-starts-at-displayed-geometry", Math.abs(reversal.before.x - reversal.after.x) < 35 &&
    Math.abs(reversal.before.y - reversal.after.y) < 40 && Math.abs(reversal.before.width - reversal.after.width) < 2, JSON.stringify(reversal));
  await page.setViewport({ width: 1050, height: 700 });
  await page.waitForFunction(() => !document.querySelector("[data-player-moving]"), { timeout: 1500 });
  const resized = await getBox(page, barCover);
  check("mini-resize-cancels-stale-flight", resized.width === full.width && resized.y + resized.height < 700, JSON.stringify(resized));
  await page.setViewport({ width: 1440, height: 900 });

  // Mock only native window geometry. Before a pending shrink no restore call is needed.
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
  await click(page, toggle);
  await page.waitForSelector(mini);
  await click(page, expand);
  await page.waitForSelector('.library-view', { timeout: 3000 });
  await wait(340);
  check("rapid-mini-return-does-not-resize-native-window", nativeCalls.length === 0);
  await click(page, toggle);
  await page.waitForSelector(mini);
  const nativeHeld = await page.evaluate(() => window.innerWidth === 1440 && document.getAnimations().some(a => a.id === "player-artwork-handoff"));
  await page.waitForFunction(() => window.innerWidth === 460, { timeout: 3000 });
  await click(page, expand);
  await page.waitForSelector('.library-view', { timeout: 3000 });
  const nativeRestored = await page.evaluate(() => window.innerWidth === 1440 && Boolean(document.querySelector('.player-bar')) && !document.querySelector('.lyrics-view'));
  check("native-resize-is-sequenced-and-restore-keeps-route", nativeHeld && nativeRestored && nativeCalls.join() === "true,false", JSON.stringify({ nativeHeld, nativeRestored, nativeCalls }));
  await wait(350);
  await page.evaluate(() => { Reflect.deleteProperty(window.cadence!.app, "setMiniPlayer"); });

  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await click(page, toggle);
  await page.waitForSelector(mini);
  await click(page, openNow);
  await page.waitForSelector(".lyrics-view");
  await page.waitForSelector(".blyrics-container");
  const reduced = await page.$eval(host, el => ({
    flight: document.getAnimations().some(animation => animation.id.endsWith("-handoff")),
    plays: Boolean((el as LyricsHost).mediaElement),
    smooth: (el as LyricsHost).tickOptions.smoothScroll,
    swipe: getComputedStyle(el.querySelector(".blyrics-container")!).getPropertyValue("--blyrics-animate-highlight-swipe").trim(),
  }));
  check("mini-and-lyrics-respect-live-reduced-motion", !reduced.flight && reduced.plays && reduced.smooth === false && reduced.swipe === "1", JSON.stringify(reduced));
  await page.emulateMediaFeatures([]);
}

export async function auditHiddenArtwork(page: Page, check: Check) {
  // Edit the existing fullscreen mode in Studio; windowed Now Playing has no art slot.
  await click(page, '[data-testid="customize-now-playing"]');
  await page.waitForSelector('[data-testid="studio-duplicate"]');
  await click(page, '[data-testid="studio-duplicate"]');
  await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".studio-mode-toggle button")]
    .find(node => node.textContent === "Fullscreen")!.click());
  await page.$eval('.np-studio input[aria-label="Show artwork"]', input => {
    if ((input as HTMLInputElement).checked) (input as HTMLInputElement).click();
  });
  await click(page, '[data-testid="studio-save"]');
  await page.waitForSelector(".np-studio", { hidden: true, timeout: 3000 });
  await click(page, '.player-bar button[aria-label="Fullscreen lyrics"]');
  const hidden = '.lyrics-view.is-fullscreen[data-profile-artwork="hidden"]';
  await page.waitForSelector(hidden, { timeout: 3000 });
  await page.keyboard.down("Control");
  await page.keyboard.down("Shift");
  await page.keyboard.press("KeyP");
  await page.keyboard.up("Shift");
  await page.keyboard.up("Control");
  await page.waitForSelector(mini);
  await wait(330);
  await click(page, openNow);
  await page.waitForSelector(hidden);
  const state = await page.$eval(hidden, node => ({
    cover: Boolean(node.querySelector(".playback-cover")?.getBoundingClientRect().width),
    flight: document.getAnimations().some(animation => animation.id === "player-artwork-handoff"),
    hosts: node.querySelectorAll("braccato-lyrics").length,
  }));
  check("mini-handoff-respects-hidden-fullscreen-art-and-mode", !state.cover && !state.flight && state.hosts === 1, JSON.stringify(state));
  await page.keyboard.press("Escape");
  await page.waitForSelector(barCover);
  await wait(330);
}
