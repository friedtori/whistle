import type { D1Migration } from "cloudflare:test";
import type { Env as WhistleEnv } from "../src/env.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WhistleEnv {
      TEST_MIGRATIONS: D1Migration[];
      WHISTLE_LIVE_TESTS: string;
    }
  }
}
