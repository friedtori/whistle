import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd (Miniflare) with a local D1 database and the
// MusicBrainzGate Durable Object from wrangler.jsonc. No Cloudflare account
// is needed. Provider HTTP is mocked at fetch / the injected http function.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            WHISTLE_LIVE_TESTS: process.env.WHISTLE_LIVE_TESTS ?? "",
            // Keep the gate test fast; production uses the 1100 ms default.
            MUSICBRAINZ_MIN_INTERVAL_MS: "200",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./tests/apply-migrations.ts"],
      testTimeout: 20_000,
    },
  };
});
