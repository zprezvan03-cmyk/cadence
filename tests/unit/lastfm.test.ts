import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isLastFmConnected,
  lastFmAuthUrl,
  lastFmGetSession,
  lastFmGetToken,
  lastFmScrobble,
  lastFmSignature,
  md5Hex,
  scrobbleThresholdSeconds,
  shouldScrobble,
} from "../../src/main/scrobble/lastfmCore";
import { parseSettingsJson } from "../../src/main/settingsCore";

const nodeMd5 = (value: string) => createHash("md5").update(value, "utf8").digest("hex");

function fakeFetch(payload: unknown, captured: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("last.fm MD5 and request signing", () => {
  it("matches RFC 1321 vectors and Node crypto on unicode/long input", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("abcdefghijklmnopqrstuvwxyz")).toBe("c3fcd3d76192e4007dfb496cca67e13b");
    for (const value of ["Cadence ♪ ünïcödé", "x".repeat(10000), "1234567890".repeat(8)]) {
      expect(md5Hex(value)).toBe(nodeMd5(value));
    }
  });

  it("signs sorted name+value pairs and excludes format/api_sig", () => {
    const params = {
      method: "track.scrobble",
      api_key: "key",
      sk: "session",
      track: "Blue",
      artist: "Someone",
      format: "json",
      api_sig: "ignored",
    };
    expect(lastFmSignature(params, "shh")).toBe(
      nodeMd5("api_keykeyartistSomeonemethodtrack.scrobblesksessiontrackBlueshh"),
    );
  });
});

describe("last.fm scrobble rules", () => {
  it("uses half the track or four minutes, and never scrobbles short tracks", () => {
    expect(scrobbleThresholdSeconds(20)).toBeNull();
    expect(scrobbleThresholdSeconds(30)).toBeNull();
    expect(scrobbleThresholdSeconds(120)).toBe(60);
    expect(scrobbleThresholdSeconds(1200)).toBe(240);
    expect(shouldScrobble({ durationSeconds: 120, listenedSeconds: 59.9, alreadyScrobbled: false })).toBe(false);
    expect(shouldScrobble({ durationSeconds: 120, listenedSeconds: 60, alreadyScrobbled: false })).toBe(true);
    expect(shouldScrobble({ durationSeconds: 120, listenedSeconds: 90, alreadyScrobbled: true })).toBe(false);
  });
});

describe("last.fm API requests", () => {
  const credentials = { apiKey: "key", apiSecret: "secret", sessionKey: "session" };

  it("requests a token with a signed POST form body", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const token = await lastFmGetToken(credentials, fakeFetch({ token: "tok123" }, captured));
    expect(token).toBe("tok123");
    expect(captured.url).toBe("https://ws.audioscrobbler.com/2.0/");
    expect(captured.init?.method).toBe("POST");
    const body = new URLSearchParams(String(captured.init?.body));
    expect(body.get("method")).toBe("auth.getToken");
    expect(body.get("api_key")).toBe("key");
    expect(body.get("format")).toBe("json");
    expect(body.get("api_sig")).toBe(nodeMd5("api_keykeymethodauth.getTokensecret"));
    expect(lastFmAuthUrl("key", "tok123")).toBe(
      "https://www.last.fm/api/auth/?api_key=key&token=tok123",
    );
  });

  it("exchanges an authorized token for a session", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const session = await lastFmGetSession(
      credentials,
      "tok123",
      fakeFetch({ session: { key: "sk-1", name: "rez" } }, captured),
    );
    expect(session).toEqual({ sessionKey: "sk-1", username: "rez" });
    const body = new URLSearchParams(String(captured.init?.body));
    expect(body.get("method")).toBe("auth.getSession");
    expect(body.get("token")).toBe("tok123");
  });

  it("scrobbles with timestamp and reports acceptance", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const accepted = await lastFmScrobble(
      credentials,
      { title: "Blue", artist: "Someone", album: "Record", duration: 201.6, trackNo: 3 },
      1700000000.8,
      fakeFetch({ scrobbles: { "@attr": { accepted: "1", ignored: "0" } } }, captured),
    );
    expect(accepted).toBe(true);
    const body = new URLSearchParams(String(captured.init?.body));
    expect(body.get("method")).toBe("track.scrobble");
    expect(body.get("timestamp")).toBe("1700000000");
    expect(body.get("duration")).toBe("202");
    expect(body.get("trackNumber")).toBe("3");
    expect(body.get("sk")).toBe("session");
    expect(body.get("api_sig")).toBeTruthy();
  });

  it("rejects last.fm error payloads", async () => {
    await expect(
      lastFmGetToken({ apiKey: "bad", apiSecret: "secret" }, fakeFetch(
        { error: 10, message: "Invalid API key" },
        {},
      )),
    ).rejects.toThrow("Invalid API key");
  });
});

describe("scrobbling settings", () => {
  it("normalizes credentials and reports connection state", () => {
    const settings = parseSettingsJson(JSON.stringify({
      scrobbling: {
        enabled: 1,
        apiKey: "  key  ",
        apiSecret: " secret ",
        sessionKey: " session ",
        username: " rez ",
      },
    }));
    expect(settings.scrobbling).toEqual({
      enabled: true,
      apiKey: "key",
      apiSecret: "secret",
      sessionKey: "session",
      username: "rez",
    });
    expect(isLastFmConnected(settings.scrobbling)).toBe(true);
    expect(parseSettingsJson(null).scrobbling.enabled).toBe(false);
  });
});
