# Seoulmate — a taste-aware guide to Korean drama

**Live demo:** https://seoulmate-dje.pages.dev

Tell Seoulmate what you already love (shows, films, music, food). It uses **Qloo's taste graph** to pick the Korean dramas that fit *your* taste, then explains the real history behind each one from a library of **142 sourced explainers** on [kdramahistory.com](https://kdramahistory.com), and pairs it with Korean food and music.

## Why Qloo is the core, not a garnish

A plain LLM can name popular K-dramas. It cannot tell *which* of them a Game of Thrones fan, as opposed to a Bridgerton fan, will actually stay up for. Seoulmate hands that decision to Qloo:

1. `search_entities` → Qloo `/search` turns each favourite into a Qloo entity ID.
2. `recommend` → Qloo `/v2/insights` with `signal.interests.entities` = those IDs, and
   - **scope `library`**: `filter.results.entities` = the Qloo IDs of the 108 dramas we have explainers for, so Qloo ranks *our* library by the user's taste;
   - **scope `korea`**: `filter.release_country` for any Korean title;
   - places (`urn:entity:place` + Korean cuisine tag + city) and artists for food and music.
3. `get_explainers` → only for titles Qloo returned.

**Grounding is enforced in code, not just in the prompt.** `get_explainers` refuses any title that did not come back from Qloo, and if Qloo is unreachable the agent says so instead of guessing (`functions/api/chat.js`).

## Architecture

- `dist/index.html` — the page (no framework).
- `functions/api/chat.js` — Cloudflare Pages Function. A Gemini (`gemini-3.8-flash`) function-calling loop over three tools that call Qloo's Hackathon API (`https://hackathon.api.qloo.com`, `X-Api-Key`).
- `functions/_data/explainers.js` — public metadata index of the explainers (title, drama, era, tags, URL). Article bodies stay on kdramahistory.com.
- `functions/_data/show_map.js` — drama title → Qloo entity ID, built by `tools/map_shows.py`.
- Cost guard: a per-visitor daily limit and a total spend cap kept in Cloudflare KV.

## Run it yourself

```bash
# 1. secrets for local dev
printf 'QLOO_API_KEY=...\nGEMINI_API_KEY=...\n' > .dev.vars
# 2. map library dramas to Qloo IDs (needs QLOO_API_KEY in your env)
python tools/map_shows.py
# 3. serve
npx wrangler@3 pages dev dist --kv KV
```

Deploy: `npx wrangler@3 pages deploy dist` with `QLOO_API_KEY` and `GEMINI_API_KEY` set as Pages secrets and a KV namespace bound as `KV`.

## Credits

Taste data: [Qloo](https://qloo.com). History explainers: kdramahistory.com (written with the SaDDungSam history channel's fact-check). Built for the Qloo Agentic Hackathon 2026.

## License

MIT — see `LICENSE`. The explainer articles themselves are not part of this repository and are not covered by this license.
