/** Unpaused production-renderer samples first; frozen visual evidence only after tracing stops. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "puppeteer-core";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const nav = (label: string) => `.nav-item[title="${label}"]`;
const first = '.library-view .track-row';
const mini = '[data-testid="mini-player"]';
const toggle = '[data-testid="open-mini-player"]';
const next = '.player-bar button[aria-label="Next track"]';
const queue = '.queue-panel';
const remove = '.queue-list > li:nth-child(2) > button[aria-label^="Remove"]';
const insert = '.context-menu button';
const revealQueue = '.player-bar button[aria-label="Queue"]';
const openNow = '.mini-player-artwork';
const closeQueue = '.queue-panel button[aria-label="Close queue"]';

export async function profileMotion(page: Page, directory: string) {
  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
  const tracePath = join(directory, "trace.json");
  const click = (selector: string) => page.$eval(selector, node => (node as HTMLElement).click());
  const shot = (name: string) => page.screenshot({ path: join(directory, `${name}.png`) as `${string}.png` });
  const audio = () => page.evaluate(() => {
    const element = Array.from(document.querySelectorAll("audio")).find(audio => !audio.paused);
    element?.pause();
  });
  const pickFirst = async () => { await click(first); await wait(300); await audio(); await wait(180); };
  const openQueue = async () => { await click(revealQueue); await page.waitForSelector(queue); await wait(370); };
  const shutQueue = async () => { await click(closeQueue); await wait(200); };
  const openContext = async () => {
    await click(`${first} button[aria-label="More actions"]`);
    await page.waitForSelector(insert);
    await wait(220);
  };
  await page.waitForSelector(nav("Home"));
  await page.waitForSelector(toggle);
  await page.exposeFunction("motionProfileResize", (compact: boolean) =>
    page.setViewport(compact ? { width: 460, height: 160 } : { width: 1440, height: 900 })
  );
  await page.evaluate(() => {
    window.cadence!.app.setMiniPlayer = (window as unknown as { motionProfileResize(value: boolean): Promise<void> }).motionProfileResize;
  });
  const enterMini = async () => {
    await click(toggle);
    await page.waitForSelector(mini);
    await page.waitForFunction(() => window.innerWidth === 460);
    await wait(120);
  };
  const followAt = async () => {
    await page.waitForFunction(() => Boolean((document.querySelector("braccato-lyrics") as (HTMLElement & { mediaElement?: HTMLMediaElement }) | null)?.mediaElement && document.querySelector(".blyrics--active")));
    await page.evaluate(() => {
      const el = document.querySelector("braccato-lyrics") as HTMLElement & { mediaElement: HTMLMediaElement };
      el.mediaElement.pause();
      el.mediaElement.currentTime = 2.5;
    });
    await wait(330);
  };

  const blocks: Record<string, { intervals: number[]; metrics: Record<string, number> }[]> = {};
  const sample = async (name: string, selector: string, text?: string) => {
    const before = await metrics();
    const result = await page.evaluate(async ({ name, selector, text }) => {
      const step = () => new Promise<number>(requestAnimationFrame);
      const el = selector === "media" ? (document.querySelector("braccato-lyrics") as HTMLElement & { mediaElement: HTMLMediaElement }).mediaElement : null;
      if (el) {
        await el.play();
        while (el.currentTime < 2.94) await step();
      }
      let last = await step();
      const start = last;
      const intervals: number[] = [];
      performance.mark(`${name}:start`);
      if (!el && selector) {
        const target = [...document.querySelectorAll<HTMLElement>(selector)].find(node => !text || node.textContent?.includes(text));
        if (!target) throw new Error(`Missing action ${selector} ${text ?? ""}`);
        target.click();
      }
      let time = last;
      // Only sample timestamps while recording; DOM reads/screenshot capture are outside the window.
      while (time - start < 520) {
        time = await step();
        intervals.push(time - last);
        last = time;
      }
      performance.mark(`${name}:end`);
      if (el) el.pause();
      return intervals;
    }, { name, selector, text });
    const after = await metrics();
    (blocks[name] ??= []).push({ intervals: result, metrics: Object.fromEntries(["LayoutCount", "LayoutDuration", "RecalcStyleCount", "RecalcStyleDuration", "ScriptDuration", "TaskDuration"].map(key => [key, after[key] - before[key]])) });
    console.log(name, result.length, "callback intervals, worst", Math.max(...result).toFixed(1));
  };

  await page.tracing.start({ path: tracePath, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing", "benchmark"] });
  try {
    await wait(650);
    await sample("idle", "");
    await sample("idle", "");
    await sample("idle", "");
    for (let i = 0; i < 3; i++) {
      await click(nav("Home"));
      await wait(390);
      await sample("navigation", nav("Songs"));
      await pickFirst();
      await sample("cover-metadata", next);
      await audio();
      await followRoute();
      await followAt();
      await sample("lyric-follow", "media");
      await click(nav("Songs"));
      await wait(320);
      await enterMini();
      await sample("mini-to-now-playing", openNow);
      await page.waitForSelector(".lyrics-view");
      await click(nav("Songs"));
      await wait(320);
      await pickFirst();
      await sample("queue-drawer-open", revealQueue);
      await openContext();
      await sample("queue-insert", insert, "Play next");
      await sample("queue-remove", remove);
      await shutQueue();
    }
  } finally {
    await page.tracing.stop();
  }
  async function followRoute() {
    await click(nav("Now Playing"));
    await page.waitForSelector(".lyrics-view");
    await wait(400);
  }

  const trace = JSON.parse(readFileSync(tracePath, "utf8")).traceEvents as {name: string; ts: number; dur?: number; ph: string; pid: number; tid: number}[];
  const percentile = (a: number[], p: number) => [...a].sort((a, b) => a - b)[Math.max(0, Math.ceil(a.length * p) - 1)] ?? 0;
  const round = (n: number) => Number(n.toFixed(2));
  const summary = Object.entries(blocks).map(([name, runs]) => {
    const intervals = runs.flatMap(run => run.intervals);
    const starts = trace.filter(event => event.name === `${name}:start`);
    const ends = trace.filter(event => event.name === `${name}:end`);
    const events = trace.filter(event => starts.some((start, index) => event.ts >= start.ts && event.ts < (ends[index]?.ts ?? 0)));
    const count = (key: string) => events.filter(event => event.name === key).length;
    const medianMetric = (key: string, multiplier = 1) => round(percentile(runs.map(run => run.metrics[key] * multiplier), 0.5));
    return {
      name, runs: runs.length, samples: intervals.length,
      rafHz: round(1000 * intervals.length / intervals.reduce((a, b) => a + b, 0)),
      p50Ms: round(percentile(intervals, 0.5)), p95Ms: round(percentile(intervals, 0.95)), maxMs: round(Math.max(...intervals)),
      over25Ms: intervals.filter(value => value > 25).length,
      medianLayoutCount: medianMetric("LayoutCount"), medianStyleCount: medianMetric("RecalcStyleCount"),
      medianLayoutMs: medianMetric("LayoutDuration", 1000), medianStyleMs: medianMetric("RecalcStyleDuration", 1000),
      medianTaskMs: medianMetric("TaskDuration", 1000),
      tracedPaints: count("Paint"), tracedRasters: count("RasterTask"), tracedDraws: count("DrawFrame"), tracedDrops: count("DroppedFrame"),
    };
  });
  writeFileSync(join(directory, "profile.json"), JSON.stringify({ browser: await page.browser().version(), summary, blocks }, null, 2));
  console.table(summary);

  const freeze = async (selector: string, at: number, wanted: string) => {
    const frozen = await page.evaluate(({ selector, at, wanted }) => {
      (document.querySelector(selector) as HTMLElement).click();
      return new Promise<string[]>(resolve => {
        const began = performance.now();
        const frame = () => {
          const active = document.getAnimations().filter(a => a.playState === "running");
          const target = active.filter(a => /player-(artwork|metadata|transport)-handoff|player-surroundings|cover-dissolve|track-text-in|track-text-out|queue-row-(move|out|in)/.test(a.id || (a as CSSAnimation).animationName || ""));
          const names = target.map(a => a.id || (a as CSSAnimation).animationName);
          if (names.includes(wanted)) {
            for (const a of target) { a.pause(); a.currentTime = at; }
            resolve(names);
          } else if (performance.now() - began > 650) resolve([]);
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
    }, { selector, at, wanted });
    if (!frozen.includes(wanted)) throw new Error(`Visual capture did not observe ${wanted}`);
    return frozen;
  };
  const finish = () => page.evaluate(() => { for (const a of document.getAnimations()) if (a.playState === "paused") a.finish(); });
  await followRoute();
  await shot("windowed-settled");
  await enterMini();
  await shot("mini-start");
  console.log("captured mini:", await freeze(openNow, 95, "player-artwork-handoff"));
  await shot("mini-mid");
  await finish();
  await wait(430);
  await shot("mini-end");
  await click(nav("Songs"));
  await wait(330);
  // Prime both URLs for the visual comparison so a title-only animation cannot be mistaken
  // for an art dissolve. This does not warm the measured samples above.
  await click(".track-row:nth-child(3)");
  await page.waitForSelector('.player-bar [data-cover-layer="current"] img[src$="blue.png"]');
  await audio();
  await pickFirst();
  await page.waitForSelector('.player-bar [data-cover-layer="current"] img[src$="amber.png"]');
  await wait(380);
  await shot("cover-start");
  console.log("captured cover:", await freeze(next, 132, "cover-dissolve"));
  await shot("cover-mid");
  await finish();
  await audio();
  await wait(370);
  await shot("cover-end");
  await pickFirst();
  await openQueue();
  console.log("captured queue:", await freeze(remove, 58, "queue-row-out"));
  await shot("queue-remove-mid");
  await finish();
  await wait(290);
  await shot("queue-remove-end");
}
