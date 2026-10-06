import type { Config } from "../config.ts";
import { canonicalUrl } from "../ids.ts";
import { asArray, asString, httpJson } from "../http.ts";
import type { Provider, SearchQuery, TrackHit } from "../types.ts";

export function createYtmProvider(config: Config): Provider {
  const enabled = Boolean(config.youtubeApiKey);

  return {
    platform: "ytm",
    enabled,
    supportsIsrcLookup: false,
    async getById(id) {
      if (!config.youtubeApiKey) return null;
      const videos = await videosById(config.youtubeApiKey, [id]);
      return videos[0] ?? null;
    },
    async getByIsrc() {
      return null;
    },
    async search(query: SearchQuery) {
      if (!config.youtubeApiKey) return [];
      const q = `${query.artists[0] ?? ""} ${query.title}`.trim();
      const res = await httpJson<{ items?: Array<{ id?: { videoId?: string } }> }>(
        `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${encodeURIComponent(config.youtubeApiKey)}`,
      );
      const ids = asArray(res.json?.items)
        .map((item) => asString((item as { id?: { videoId?: string } }).id?.videoId))
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) return [];
      return videosById(config.youtubeApiKey, ids);
    },
  };
}

async function videosById(apiKey: string, ids: string[]): Promise<TrackHit[]> {
  const res = await httpJson<{
    items?: Array<{
      id?: string;
      snippet?: { title?: string; channelTitle?: string };
      contentDetails?: { duration?: string };
    }>;
  }>(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${ids.map(encodeURIComponent).join(",")}&key=${encodeURIComponent(apiKey)}`,
  );
  const hits: TrackHit[] = [];
  for (const raw of asArray(res.json?.items)) {
    const item = raw as {
      id?: string;
      snippet?: { title?: string; channelTitle?: string };
      contentDetails?: { duration?: string };
    };
    const id = asString(item.id);
    const title = asString(item.snippet?.title);
    if (!id || !title) continue;
    hits.push({
      platform: "ytm",
      id,
      url: canonicalUrl("ytm", id),
      title,
      artists: asString(item.snippet?.channelTitle) ? [item.snippet!.channelTitle!] : [],
      duration_ms: parseIsoDuration(item.contentDetails?.duration),
    });
  }
  return hits;
}

export function parseIsoDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!m) return null;
  return Math.round((Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) * 1000);
}
