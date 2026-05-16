import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config, getConfig, setConfig, getRemoteCoreUrl } from "../src/config";

describe("config", () => {
  // Config is module-global; snapshot and restore so tests don't bleed into
  // one another or into sibling test files that evaluate the module.
  let snapshot: { tagNames: { stripe: string }; remote: { enableRemote: boolean; remoteSettingType: "env" | "config"; remoteCoreUrl: string } };
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
    STRIPE_REMOTE_CORE_URL?: string;
  };
  let savedProcessEnv: string | undefined;
  let savedGlobalUrl: string | undefined;
  let hadGlobalUrlKey = false;

  beforeEach(() => {
    snapshot = {
      tagNames: { stripe: config.tagNames.stripe },
      remote: {
        enableRemote: config.remote.enableRemote,
        remoteSettingType: config.remote.remoteSettingType,
        remoteCoreUrl: config.remote.remoteCoreUrl,
      },
    };
    savedProcessEnv = g.process?.env?.STRIPE_REMOTE_CORE_URL;
    hadGlobalUrlKey = "STRIPE_REMOTE_CORE_URL" in g;
    savedGlobalUrl = g.STRIPE_REMOTE_CORE_URL;
  });

  afterEach(() => {
    setConfig({
      tagNames: { stripe: snapshot.tagNames.stripe },
      remote: {
        enableRemote: snapshot.remote.enableRemote,
        remoteSettingType: snapshot.remote.remoteSettingType,
        remoteCoreUrl: snapshot.remote.remoteCoreUrl,
      },
    });
    if (g.process?.env) {
      if (savedProcessEnv === undefined) delete g.process.env.STRIPE_REMOTE_CORE_URL;
      else g.process.env.STRIPE_REMOTE_CORE_URL = savedProcessEnv;
    }
    if (hadGlobalUrlKey) g.STRIPE_REMOTE_CORE_URL = savedGlobalUrl;
    else delete g.STRIPE_REMOTE_CORE_URL;
  });

  describe("defaults", () => {
    it("exposes sensible defaults for tag name and remote flags", () => {
      expect(config.tagNames.stripe).toBe("stripe-checkout");
      expect(config.remote.enableRemote).toBe(false);
      expect(config.remote.remoteSettingType).toBe("config");
      expect(config.remote.remoteCoreUrl).toBe("");
    });
  });

  describe("setConfig / getConfig", () => {
    it("setConfig merges partial updates without clobbering unset fields", () => {
      setConfig({ remote: { remoteCoreUrl: "ws://example.test/core" } });
      expect(config.remote.remoteCoreUrl).toBe("ws://example.test/core");
      // Other fields must retain their prior values.
      expect(config.remote.enableRemote).toBe(false);
      expect(config.remote.remoteSettingType).toBe("config");
      expect(config.tagNames.stripe).toBe("stripe-checkout");
    });

    it("getConfig returns a deep-frozen snapshot decoupled from later mutation", () => {
      setConfig({ remote: { remoteCoreUrl: "ws://before/" } });
      const before = getConfig();
      expect(before.remote.remoteCoreUrl).toBe("ws://before/");
      // Deep freeze — runtime mutation of the returned snapshot must fail.
      expect(() => {
        (before.remote as unknown as { remoteCoreUrl: string }).remoteCoreUrl = "ws://tampered/";
      }).toThrow();
      setConfig({ remote: { remoteCoreUrl: "ws://after/" } });
      // The earlier snapshot is a frozen clone, untouched by the later set.
      expect(before.remote.remoteCoreUrl).toBe("ws://before/");
      // A fresh snapshot reflects the new value.
      expect(getConfig().remote.remoteCoreUrl).toBe("ws://after/");
    });

    it("throws when remoteSettingType is outside enum", () => {
      expect(() => {
        setConfig({ remote: { remoteSettingType: "weird" as any } });
      }).toThrow(/remoteSettingType/);
    });

    it("throws when remoteCoreUrl is not a string", () => {
      expect(() => {
        setConfig({ remote: { remoteCoreUrl: 123 as any } });
      }).toThrow(/remoteCoreUrl/);
    });

    it("throws when enableRemote is not a boolean", () => {
      expect(() => {
        setConfig({ remote: { enableRemote: "true" as any } });
      }).toThrow(/enableRemote/);
    });

    it("throws when tagNames.stripe is not a string", () => {
      expect(() => {
        setConfig({ tagNames: { stripe: 123 as any } });
      }).toThrow(/tagNames\.stripe/);
    });

    it("throws when tagNames.stripe is null", () => {
      expect(() => {
        setConfig({ tagNames: { stripe: null as any } });
      }).toThrow(/tagNames\.stripe/);
    });

    it("leaves config unchanged when validation fails", () => {
      setConfig({ remote: { enableRemote: true, remoteCoreUrl: "ws://before/" } });
      expect(() => {
        setConfig({ remote: { remoteCoreUrl: 123 as any, enableRemote: false } });
      }).toThrow();
      expect(config.remote.enableRemote).toBe(true);
      expect(config.remote.remoteCoreUrl).toBe("ws://before/");
    });

    it("rejects ws:// for non-loopback hosts unless NODE_ENV=test", () => {
      // Security: clientSecret crosses the WebSocket; ws:// on the open
      // internet is a MITM oracle. The validator rejects ws:// for
      // non-loopback hosts UNLESS `process.env.NODE_ENV === "test"`
      // (the default vitest tier, which is also why every other test
      // here can keep using `ws://...`).
      const savedNodeEnv = (globalThis as any).process?.env?.NODE_ENV;
      try {
        if ((globalThis as any).process?.env) {
          (globalThis as any).process.env.NODE_ENV = "production";
        }
        // Non-loopback ws:// MUST be rejected outside test env.
        expect(() => {
          setConfig({ remote: { remoteCoreUrl: "ws://api.example.com/core" } });
        }).toThrow(/ws:\/\/ against a non-loopback host/);
        // Loopback ws:// is allowed even outside test env.
        expect(() => {
          setConfig({ remote: { remoteCoreUrl: "ws://localhost:8080/" } });
        }).not.toThrow();
        expect(() => {
          setConfig({ remote: { remoteCoreUrl: "ws://127.0.0.1:8080/" } });
        }).not.toThrow();
        // wss:// always passes.
        expect(() => {
          setConfig({ remote: { remoteCoreUrl: "wss://api.example.com/core" } });
        }).not.toThrow();
      } finally {
        if ((globalThis as any).process?.env) {
          if (savedNodeEnv === undefined) delete (globalThis as any).process.env.NODE_ENV;
          else (globalThis as any).process.env.NODE_ENV = savedNodeEnv;
        }
      }
    });

    it("rejects unparseable ws:// URLs outside NODE_ENV=test (regression: malformed-URL bypass)", () => {
      // Regression: the security gate previously short-circuited on
      // `host = ""` from a `new URL(url)` parse failure, letting
      // `ws://[malformed]` strings flow through to the WebSocket
      // constructor's opaque error path. The validator now rejects
      // unparseable ws:// URLs explicitly (NODE_ENV=test still escapes
      // because happy-dom's own "WebSocket constructor throws on URL
      // parse" exercise depends on accepting such strings).
      const savedNodeEnv = (globalThis as any).process?.env?.NODE_ENV;
      try {
        if ((globalThis as any).process?.env) {
          (globalThis as any).process.env.NODE_ENV = "production";
        }
        expect(() => {
          setConfig({ remote: { remoteCoreUrl: "ws://malformed url with spaces" } });
        }).toThrow(/not a parseable URL/);
      } finally {
        if ((globalThis as any).process?.env) {
          if (savedNodeEnv === undefined) delete (globalThis as any).process.env.NODE_ENV;
          else (globalThis as any).process.env.NODE_ENV = savedNodeEnv;
        }
      }
    });

    it("leaves config unchanged when POST-merge validation fails (atomic commit, regression)", () => {
      // Regression: setConfig used to merge into `_config` first and
      // only run the `enableRemote + empty URL` check afterward. A
      // throw at the post-merge check would leave `_config.remote.
      // enableRemote = true` stuck, so a later "legitimate" setConfig
      // that only supplies the URL would quietly succeed against the
      // leaked state. The staging + atomic-commit fix ensures a failed
      // setConfig has zero effect.
      expect(config.remote.enableRemote).toBe(false);
      expect(config.remote.remoteCoreUrl).toBe("");
      expect(() => {
        // enableRemote=true with no URL must fail AND not leak state.
        setConfig({ remote: { enableRemote: true } });
      }).toThrow(/remoteCoreUrl is empty/);
      // enableRemote must still be false afterwards.
      expect(config.remote.enableRemote).toBe(false);
      expect(config.remote.remoteCoreUrl).toBe("");
      // A URL-only setConfig that SHOULD be a no-op-for-enableRemote
      // must remain so: enableRemote does not magically turn true.
      setConfig({ remote: { remoteCoreUrl: "ws://later/" } });
      expect(config.remote.enableRemote).toBe(false);
      expect(config.remote.remoteCoreUrl).toBe("ws://later/");
    });
  });

  describe("getRemoteCoreUrl", () => {
    it("remoteSettingType=\"config\" returns the configured URL verbatim", () => {
      setConfig({ remote: { remoteSettingType: "config", remoteCoreUrl: "wss://api.test/stripe" } });
      expect(getRemoteCoreUrl()).toBe("wss://api.test/stripe");
    });

    it("remoteSettingType=\"env\" reads process.env.STRIPE_REMOTE_CORE_URL first", () => {
      setConfig({ remote: { remoteSettingType: "env", remoteCoreUrl: "wss://ignored/" } });
      // Under vitest we are in Node — process.env exists. Guarantee a value.
      g.process = g.process ?? { env: {} };
      g.process.env = g.process.env ?? {};
      g.process.env.STRIPE_REMOTE_CORE_URL = "wss://from-process-env/";
      expect(getRemoteCoreUrl()).toBe("wss://from-process-env/");
    });

    it("remoteSettingType=\"env\" falls back to globalThis.STRIPE_REMOTE_CORE_URL for browser bundles", () => {
      // Browser bundles do not populate process.env; the resolver checks
      // a global the bundler can inject before script eval. This path is
      // the regression the reviewer flagged.
      setConfig({ remote: { remoteSettingType: "env", remoteCoreUrl: "wss://ignored/" } });
      if (g.process?.env) delete g.process.env.STRIPE_REMOTE_CORE_URL;
      g.STRIPE_REMOTE_CORE_URL = "wss://from-global/";
      expect(getRemoteCoreUrl()).toBe("wss://from-global/");
    });

    it("remoteSettingType=\"env\" returns empty string when neither source is set", () => {
      setConfig({ remote: { remoteSettingType: "env", remoteCoreUrl: "wss://ignored/" } });
      if (g.process?.env) delete g.process.env.STRIPE_REMOTE_CORE_URL;
      delete g.STRIPE_REMOTE_CORE_URL;
      expect(getRemoteCoreUrl()).toBe("");
    });
  });
});
