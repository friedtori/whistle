import "dotenv/config";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { createProviders } from "./providers/index.ts";

const config = loadConfig();
const db = new Store(config.databasePath);
const providers = createProviders(config);
const app = createApp({ db, providers });

const server = app.listen(config.port, () => {
  const enabled = Object.entries(providers)
    .filter(([, provider]) => provider.enabled)
    .map(([name]) => name)
    .join(", ");
  console.log(`Whistle listening on :${config.port} (providers: ${enabled})`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
