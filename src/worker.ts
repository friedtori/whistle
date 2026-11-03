import { createApp, type RequestServices } from "./app.ts";
import { loadConfig } from "./config.ts";
import { D1Store } from "./db.ts";
import type { Env } from "./env.ts";
import { createHttpJson, SubrequestBudget } from "./http.ts";
import { createDurableMbGate } from "./musicbrainz-gate.ts";
import { createProviders } from "./providers/index.ts";

export { MusicBrainzGate } from "./musicbrainz-gate.ts";

export function servicesFromEnv(env: Env): RequestServices {
  const config = loadConfig(env as unknown as Record<string, unknown>);
  const budget = new SubrequestBudget(config.subrequestLimit);
  return {
    config,
    budget,
    db: new D1Store(env.DB, budget),
    providers: (spend) =>
      createProviders(config, {
        http: createHttpJson(spend),
        mbGate: createDurableMbGate(env.MUSICBRAINZ_GATE, spend),
      }),
  };
}

const app = createApp((env) => servicesFromEnv(env as unknown as Env));

export default {
  fetch: (request, env, ctx) => app.fetch(request, env as unknown as Record<string, unknown>, ctx),
} satisfies ExportedHandler<Env>;
