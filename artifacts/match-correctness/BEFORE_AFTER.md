# Match correctness — archive vs current rules

Provenance: `/tmp/whistle-seed` unpacked export (results-fuzzy.jsonl 900, results-isrc.jsonl 374). No commit field. Produced against **main@ecf605b** (has `isrc_from_fuzzy`, no `recording_confidence`, bootstrap fuzzy collapsed to 0.65). Coverage 870/900 and 374/374 is **resolver-success**, not accuracy. `cached:false` does not mean the recording/links were new — `findOrCreateRecording` reused by ISRC/mbid/platform id.

This document distinguishes **verified recording identity** (is this the right song?) from **destination-link coverage** (how many platforms got a URL). Coverage drops on the five identity 404s because those archive “successes” were false positives.

Rule version: `2026-10-07.identity-destination.2`. Replay: `npm run replay:seed-archive` (named + dry-fixtures by default).

## Identity conflicts (fuzzy) — reject false positives

| Case | Input key | Archive (ecf605b) | Current intended | Identity vs coverage |
| --- | --- | --- | --- | --- |
| Oh No Now My | `this is lorelei\toh no now my\toh no now my\t188000` | **ok** → recording `9v6e4hxl4hz3` titled **Billy Came Back**; shared Apple/Tidal/Spotify/YTM URLs with Billy Came Back (`7ozo0lcvlir5`, 189s) | **404**. Title floor rejects Billy Came Back. After Billy is seeded, still 404; do not reuse that recording or its URLs | Archive identity was **wrong**. Coverage of Billy’s links on the Oh No Now My query was inherited, not verified. |
| SYW | `empress of\tsyw (feat. cecile believe)\tsyw (feat. cecile believe)\t167000` | **ok** → **Wild Storm** `pcgb6fx0kall` (also ISRC row 134 / HandsOn), links 0.9–1.0, `cached:false` | **404** on Wild Storm–only search. After Wild Storm seeded via ISRC `QM24S2602823`, still 404; no inherited Apple `…/6782918578` or Deezer `…/4022342901` | Recording reuse / identity coalesce. Query uncertainty must not inherit Wild Storm’s trusted links. |
| HandsOn | `empress of\thandson\thandson\t169000` | **ok** → same **Wild Storm** `pcgb6fx0kall` | **404** (clean store already in PR #5). Seeded Wild Storm still 404; `HandsOn`/`Hands On` collapse remains accepted when that is the hit | Same reuse class as SYW. |
| Pigwig | `bloc party\tpigwig\tpigwig\t210000` | **ok** → **Now We Can't Be Friends** `q0hb91c9ise7`; shared Apple+Tidal URLs with `k6rw9pagn7de` (both 210s) | **404**. After Now We Can't Be Friends is seeded, still 404; those Apple/Tidal URLs stay off Pigwig | Same-script unrelated titles. Title floor, not Unicode stripping. |
| Dexter | `ricardo villalobos\tdexter\tdexter\t549000` | **ok** → **Nord** `czgbcqukfa7o` | **404** at archive duration 549000 | Unrelated title, duration-valid only. |

These five are the latin-only title-floor archive hits with sim&lt;0.5 that are **true identity failures**. Coverage reduction here is rejected false positives, not lost true matches.

## Must remain accepted

| Case | Archive | Current intended |
| --- | --- | --- |
| AL-90 `Завуалированный Сигнал` (fuzzy row 206, 306000) | **ok** → same Cyrillic title | **accept**. Unicode-preserving `normalizeTitle` (`\p{L}\p{N}`). Latin-only normalize would score 0 — a **false positive reject**. Sixth archive fuzzy-ok row with latin-only sim&lt;0.5. |
| Sneaker Pimps / Spin Spin Sugar / Becoming Remixed / 543000 | **ok** → Armand's Dark Garage Mix | **accept** that mix over a short original. Duration + album disambiguate **after** identity; remix family comes from the album name `Becoming Remixed`. |
| Featured-artist overlap (Ariana Grande feat. Iggy Azalea) | n/a (control) | **accept** |
| Transliteration hatch: 気分上々↑↑ vs Kibun Jou Jou, same artist + duration | ISRC row 124 recording identity was Kibun Jou Jou / mihimaru GT (correct) | Query must **not 404**. Title floor skipped across scripts; artist + duration + version still apply. |

## Destination-link coverage (ISRC Apple URL-version leaks)

Recording identity in the archive was **correct**. Apple destination was **not**. All five are `method:fuzzy` @ ~0.8 because TrackHit.title omitted Cover/Instrumental/Acoustic/Karaoke — those words lived in the URL slug / album. `evaluateFuzzy` never saw them. Unauthenticated `itunesLookupByIsrc` `search?term=${isrc}` first-result is removed; `lookup?isrc=` miss → null.

| ISRC row | Source recording (keep) | Archive Apple | Current Apple |
| --- | --- | --- | --- |
| 124 `JPPO00605880` | Kibun Jou Jou / mihimaru GT | fuzzy 0.8 `…/kibun-jou-jou-cover/…` (page: Cover, artist Harusaruhi) | **unmatched** `destination_mismatch` (URL/album cover + artist) |
| 327 `USUM71405403` | Problem / Ariana Grande | `…/problem-instrumental/…` | **unmatched** instrumental URL/album |
| 341 `USUM71809768` | UDK / Olivia O'Brien | `…/udk-acoustic/…` | **unmatched** acoustic URL/album |
| 288 `USSM12402705` | BLACKBIIRD / Beyoncé | `…/blackbiird-karaoke-version-…` | **unmatched** karaoke URL |
| 342 `USUM71819361` | thank u, next / Ariana Grande | `…/thank-u-next-instrumental/…` (0.7382) | **unmatched** instrumental URL |

Deezer/Tidal/MusicBrainz ISRC hops on these rows stay valid when they match the recording.

## Version-review

| Case | Archive | Current |
| --- | --- | --- |
| thicc (row 421) `shygirl\tthicc\tthicc (fedde le grand remix)\t223000` | **ok** → **thicc (acapella)** | Query **title** is bare `thicc`; remix lives on **album**. vs acapella-only → **404**; vs remix → **accept remix**; vs both → remix (album preference after identity), never acapella. Album alone does not pick a remix when identity fails. |
| Midnight Sun (row 592) `zara larsson\tmidnight sun\tmidnight sun\t190000` | **ok** → **Midnight Sun (Super Loud)** | **version-review**. Super Loud is not a known version family. Current acceptable: accept Super Loud when it is the only duration-valid hit (paren-stripped identity), **or** unmatched if a conservative paren guard is added later. Prefer bare “Midnight Sun” when both exist. Do not hard-404 Super Loud-only. |

## Why archive failures happened (ecf605b already had cover/karaoke/instrumental/acoustic families)

1. No title floor → unrelated titles accepted on duration, then ISRC-expanded.
2. Apple dest fuzzy used `TrackHit.title`, which often omitted Cover/Instrumental/Acoustic/Karaoke.
3. Unauthenticated Apple `search?term=${isrc}` returned `results[0]`; `fromItunes` does not populate ISRC.
4. Destination fuzzy did not filter by artist (bootstrap did).
5. SYW + HandsOn coalesced onto Wild Storm `pcgb6fx0kall`.
6. Oh No Now My (188s) shared DSP URLs with Billy Came Back (189s), different recording IDs.
7. Pigwig shared Apple+Tidal URLs with Now We Can't Be Friends (both 210s), different recording IDs.

## Evidence (public resolve, no secrets)

`evidence.matching_rule_version`, optional `commit`, `cached`, `recording_reused`, `reuse_via` (`input_cache` \| `isrc` \| `mbid` \| `platform_id` \| null), `query_match`, `source`, `destinations[]`, `providers_enabled[]`, `credentials_skipped` (count). Replay JSON carries the same fields.

On a **fresh** resolve, `query_match.confidence` is the input→recording score (fuzzy selection or trusted ISRC). After an identity-matching ISRC coalesce, `recording_confidence` stays write-once (0.98) while `query_match` still reports the fuzzy score. Cached `/v1/resolve` and `GET /v1/recordings/:id` reconstruct `query_match` as `{ reason: "reconstructed_from_cache", confidence: null }` — do not treat that as a new measurement. `evidence.source` is omitted when the platform of the original candidate cannot be recovered.
