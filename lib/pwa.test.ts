import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifestRoute from "@/app/manifest";

const require = createRequire(import.meta.url);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = manifestRoute();

function readProjectFile(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

/** Source with comments removed, so guardrails check code, not prose. */
function readCode(relativePath: string): string {
  return readProjectFile(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function pngDimensions(relativePath: string): { width: number; height: number } {
  const png = readFileSync(join(projectRoot, relativePath));
  // Signature (8) + IHDR length (4) + type (4), then width and height as
  // big-endian uint32.
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

describe("web app manifest", () => {
  it("meets the installability criteria", () => {
    expect(manifest.name || manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    const sizes = (manifest.icons ?? []).map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
  });

  it("contains only static, user-agnostic values", () => {
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/token|secret|cookie|session/i);
    expect(manifest.start_url).not.toMatch(/\?/); // no per-user query
  });

  it("declares an any and a maskable icon at every size", () => {
    const purposes = (manifest.icons ?? []).map((icon) => icon.purpose);
    expect(purposes).toContain("any");
    expect(purposes).toContain("maskable");
    for (const icon of manifest.icons ?? []) {
      expect(icon.src).toMatch(/^\/icons\//);
      const dimensions = pngDimensions(join("public", icon.src));
      expect(icon.sizes).toBe(`${dimensions.width}x${dimensions.height}`);
    }
  });
});

describe("icon files", () => {
  it("sized for their targets", () => {
    expect(pngDimensions("app/icon.png")).toEqual({ width: 32, height: 32 });
    // Apple home-screen icons are 180x180 and full bleed (Apple masks them).
    expect(pngDimensions("app/apple-icon.png")).toEqual({
      width: 180,
      height: 180,
    });
  });
});

describe("auth proxy matcher", () => {
  // Compiles a matcher string the same way Next.js does at build time
  // (mirrors getMiddlewareMatchers in next/dist/build/analysis/
  // get-page-static-info.js: nextData prefix + transport suffix, parsed with
  // the bundled path-to-regexp).
  function compileLikeNext(originalSource: string): RegExp {
    const { parse, tokensToRegexp } = require("next/dist/compiled/path-to-regexp");
    const { RSC_SUFFIX, RSC_SEGMENTS_DIR_SUFFIX, RSC_SEGMENT_SUFFIX } =
      require("next/dist/lib/constants");
    const sourceSuffix = `{(\\.json|${RSC_SUFFIX}|${RSC_SEGMENTS_DIR_SUFFIX}/.+${RSC_SEGMENT_SUFFIX})}?`;
    const source = `/:nextData(_next/data/[^/]{1,})?${originalSource}${sourceSuffix}`;
    return new RegExp(tokensToRegexp(parse(source)).source, "i");
  }

  const proxySource = readProjectFile("proxy.ts");
  const literal = proxySource.match(/matcher:\s*\[\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  const matcherRegex = compileLikeNext(JSON.parse(`"${literal}"`));

  // A path "matching" the matcher means the auth proxy RUNS for it; no match
  // means the proxy is skipped and the path is reachable while signed out.
  it("exempts exactly the public PWA assets", () => {
    const publicPaths = [
      "/icon.png",
      "/apple-icon.png",
      "/manifest.webmanifest",
      "/sw.js",
      "/offline.html",
      "/icons/icon-192.png",
      "/icons/icon-maskable-512.png",
      // Pre-existing exemptions that must keep working:
      "/signin",
      "/api/auth/callback/oidc",
      "/_next/static/chunks/main.js",
      "/favicon.ico",
    ];
    for (const path of publicPaths) {
      expect(matcherRegex.test(path), `${path} must be exempt`).toBe(false);
    }
  });

  it("keeps lookalike paths protected", () => {
    const protectedPaths = [
      "/",
      "/sessions",
      "/api/sessions",
      "/api/events",
      // Bare extension-less forms of the asset names:
      "/icon",
      "/apple-icon",
      "/sw",
      // Near-misses of every added token:
      "/iconXpng",
      "/icon.png2",
      "/icon.png/evil",
      "/iconic",
      "/iconsfoo",
      "/apple-icon.pngX",
      "/apple-iconX.png",
      "/apple-icons",
      "/manifest.webmanifestX",
      "/manifestXwebmanifest",
      "/manifest.webmanifest/evil",
      "/swXjs",
      "/sw.jsX",
      "/sw.js/evil",
      "/swxjs",
      "/offline.htmlX",
      "/offline.html/evil",
      "/offlineXhtml",
    ];
    for (const path of protectedPaths) {
      expect(matcherRegex.test(path), `${path} must run the auth proxy`).toBe(
        true,
      );
    }
  });
});

type FakeRequest = { url: string; mode: string; method: string };
type PhaseEvent = { waitUntil: (promise: Promise<void>) => void };
type FetchEvent = {
  request: FakeRequest;
  respondWith: (promise: Promise<unknown>) => void;
};

/**
 * Loads public/sw.js in a Node vm with a minimal service-worker environment
 * so the behavioral rules (what gets intercepted, what gets cached and
 * deleted) can be exercised without a browser.
 */
function loadServiceWorker(options: {
  network: "ok" | "fail";
  preseededCaches?: string[];
}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, unknown>>();
  const deleted: string[] = [];
  const network = { fail: options.network === "fail" };

  for (const name of options.preseededCaches ?? []) {
    stores.set(name, new Map());
  }

  const networkFetch = (request: { url: string }) => {
    if (network.fail) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    return Promise.resolve({ ok: true, url: request.url, body: "network" });
  };

  const context = vm.createContext({
    self: {
      addEventListener: (type: string, fn: (event: unknown) => void) => {
        handlers.set(type, fn);
      },
      skipWaiting: () => Promise.resolve(),
      clients: { claim: () => Promise.resolve() },
    },
    caches: {
      open: (name: string) => {
        let store = stores.get(name);
        if (!store) {
          store = new Map();
          stores.set(name, store);
        }
        return Promise.resolve({
          add: async (request: FakeRequest) => {
            await networkFetch(request);
            const key = new URL(request.url).pathname;
            // Store a response-like record keyed by path, as the worker
            // retrieves it via cache.match("/offline.html").
            store.set(key, { ok: true, url: key });
          },
          match: async (url: string) => store.get(url),
        });
      },
      keys: () => Promise.resolve([...stores.keys()]),
      delete: (name: string) => {
        deleted.push(name);
        stores.delete(name);
        return Promise.resolve(true);
      },
    },
    fetch: networkFetch,
    Request: class {
      url: string;
      cache?: string;
      constructor(input: string, init?: { cache?: string }) {
        this.url = new URL(input, "http://localhost").href;
        if (init) Object.assign(this, init);
      }
    },
    URL,
    console,
  });

  vm.runInContext(readProjectFile("public/sw.js"), context);

  const runPhase = async (phase: "install" | "activate") => {
    let pending: Promise<void> | undefined;
    const handler = handlers.get(phase) as ((event: PhaseEvent) => void) | undefined;
    handler?.({
      waitUntil: (promise: Promise<void>) => {
        pending = promise;
      },
    });
    await pending;
  };

  const dispatchFetch = async (request: FakeRequest) => {
    let responded: Promise<unknown> | undefined;
    const handler = handlers.get("fetch") as ((event: FetchEvent) => void) | undefined;
    handler?.({
      request,
      respondWith: (promise: Promise<unknown>) => {
        responded = promise;
      },
    });
    if (!responded) return { intercepted: false as const, response: undefined };
    return { intercepted: true as const, response: await responded };
  };

  return {
    stores,
    deleted,
    install: () => runPhase("install"),
    activate: () => runPhase("activate"),
    dispatchFetch,
    /** Flip the network off after a successful install (going "offline"). */
    goOffline: () => {
      network.fail = true;
    },
  };
}

const CURRENT_CACHE = "opencode-client-offline-v2";

describe("service worker behavior", () => {
  it("installs only the offline page into its own cache", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: ["other-app-data"] });
    await sw.install();
    expect([...sw.stores.keys()].sort()).toEqual([
      CURRENT_CACHE,
      "other-app-data",
    ]);
    expect([...sw.stores.get(CURRENT_CACHE)!.keys()]).toEqual(["/offline.html"]);
  });

  it("activation deletes only same-prefix caches, preserving unrelated ones", async () => {
    const sw = loadServiceWorker({
      network: "ok",
      preseededCaches: [
        "other-app-data",
        "another-pwa-runtime-cache",
        "opencode-client-offline-v1",
      ],
    });
    await sw.install();
    await sw.activate();
    expect(sw.deleted).toEqual(["opencode-client-offline-v1"]);
    expect([...sw.stores.keys()].sort()).toEqual([
      "another-pwa-runtime-cache",
      CURRENT_CACHE,
      "other-app-data",
    ]);
  });

  it("passes navigations through to the network while reachable", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: ["other-app-data"] });
    await sw.install();
    const result = await sw.dispatchFetch({
      url: "https://app.example.com/",
      mode: "navigate",
      method: "GET",
    });
    expect(result.intercepted).toBe(true);
    expect(result.response).toMatchObject({ url: "https://app.example.com/" });
    // Nothing beyond the offline page was stored.
    expect(sw.stores.get("other-app-data")!.size).toBe(0);
  });

  it("serves the offline page only for failed non-API navigations", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    const result = await sw.dispatchFetch({
      url: "https://app.example.com/",
      mode: "navigate",
      method: "GET",
    });
    expect(result.intercepted).toBe(true);
    expect(result.response).toMatchObject({ url: "/offline.html" });
  });

  it("never intercepts API or auth paths, even as navigations while offline", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    for (const path of ["/api/sessions", "/api/auth/callback/oidc?code=x", "/api/events"]) {
      const result = await sw.dispatchFetch({
        url: `https://app.example.com${path}`,
        mode: "navigate",
        method: "GET",
      });
      expect(result.intercepted, path).toBe(false);
    }
  });

  it("never intercepts subresource or non-GET requests", async () => {
    const sw = loadServiceWorker({ network: "ok", preseededCaches: [] });
    await sw.install();
    sw.goOffline();
    for (const request of [
      { url: "https://app.example.com/api/events", mode: "cors", method: "GET" },
      { url: "https://app.example.com/", mode: "same-origin", method: "POST" },
    ]) {
      const result = await sw.dispatchFetch(request);
      expect(result.intercepted, request.url).toBe(false);
    }
  });
});

describe("service worker source invariants", () => {
  const source = readCode("public/sw.js");

  it("only intercepts top-level GET navigations outside /api/", () => {
    expect(source).toContain('request.mode !== "navigate"');
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain('pathname.startsWith("/api/")');
    // The API gate runs before anything can be answered by the worker.
    expect(source.indexOf('pathname.startsWith("/api/")')).toBeLessThan(
      source.indexOf("event.respondWith"),
    );
    // "/api" appears exactly once: as the exclusion, never as a fetch/cache
    // target.
    expect(source.match(/\/api\//g)?.length).toBe(1);
    expect(source).not.toMatch(/cookie|authorization|token|session/i);
  });

  it("caches nothing except the static offline page", () => {
    expect(source).toContain('OFFLINE_URL = "/offline.html"');
    expect(source.match(/cache\.add\(/g)?.length).toBe(1);
    expect(source).not.toContain("cache.addAll");
    // Navigations always hit the network first; the cache is only consulted
    // when the network request throws.
    expect(source).toContain("await fetch(request)");
    expect(source.indexOf("await fetch(request)")).toBeLessThan(
      source.indexOf("cache.match("),
    );
  });

  it("scopes cache cleanup to its own prefix", () => {
    expect(source).toContain('CACHE_PREFIX = "opencode-client-offline-"');
    expect(source).toContain("name.startsWith(CACHE_PREFIX)");
    expect(source).toContain("name !== CACHE_NAME");
    expect(source.match(/caches\.delete\(/g)?.length).toBe(1);
  });
});

describe("offline fallback page", () => {
  const source = readProjectFile("public/offline.html");

  it("is fully self-contained", () => {
    // No external requests: the page must render with no network at all.
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\ssrc="/);
    expect(source).not.toMatch(/\shref="/);
  });

  it("does not imply offline functionality", () => {
    expect(source).toMatch(/offline/i);
    expect(source).toMatch(/needs a connection/i);
  });
});
