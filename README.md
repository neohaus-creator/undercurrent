# Undercurrent — what your customers love but never tell you

**Live demo:** https://seoulmate-dje.pages.dev

Small businesses market on what customers *say*: "the coffee is good", "it looks nice". Everyone says that, so everyone markets the same way. The reasons people actually keep coming back sit outside the business's own category — the films, music, brands and places its customers love more than everyone else does. Customers can't put that into words, a survey won't surface it, and an LLM can only guess.

Undercurrent asks **Qloo's taste graph**. Give it your business name (and optionally a city and one or two look-alikes). An agent finds you in the graph, measures what your customers are drawn to in other categories **after subtracting what the general public of your city likes anyway**, and turns that evidence into this month's marketing: an event, a product or menu idea, a playlist, local collaborations, ad-targeting interests and three ready-to-post captions.

## What only works because of Qloo

| Step | Qloo call | What it gives |
|---|---|---|
| Find you | `/search` (`urn:entity:place` / `brand` / …) | your business as an entity |
| Mood words | `/v2/insights`, `filter.type=urn:tag` (taste analysis) | how your audience's taste is described |
| **Hidden pulls** | `/v2/insights` per category (artist, movie, tv_show, brand, book, podcast, destination) with `signal.interests.entities` = you, `feature.explainability=true` | what your customers love elsewhere |
| **Subtract the obvious** | the same category with only your city as the signal (`signal.location.query`, top 200 over four pages of 50, cached daily) | what everyone around you loves |
| Neighbours | `/v2/insights`, `urn:entity:place` + `filter.location.query` | nearby places with an overlapping audience |

Qloo's affinity score measures similarity between entities and is normalised per query, so a top result can simply be something popular with everybody. Undercurrent checks every result against the **general top 200 for the same category in your area** (Qloo needs at least one signal, so the city is the neutral baseline; without a city, the United States). An item that is not in that top 200 is marked **hidden** — a pull your audience has that the area at large doesn't; an item that is in it shows its local rank and is treated as "everyone likes this". We report only that comparison — no invented lift score — and if the baseline call fails, nothing is called hidden.

## Guard rails

- **No Qloo evidence, no answer.** If the business and its look-alikes can't be found, Qloo only returns unrelated matches, or Qloo is unreachable, the agent says so instead of writing a plausible-sounding plan (`functions/api/chat.js`).
- At least four categories are measured before the playbook is written — enforced in code, not only in the prompt.
- Wording: these are tastes Qloo associates with the business and its audience, not a survey of its actual buyers.
- The playbook may only use names returned by the tools, and cites the numbers next to each claim.
- Cost guard: per-visitor daily limit and a total spend cap in Cloudflare KV.

## Architecture

- `dist/index.html` — the page (no framework).
- `functions/api/chat.js` — Cloudflare Pages Function: a Gemini (`gemini-3.8-flash`) function-calling loop over four Qloo-backed tools (`find_entity`, `taste_keywords`, `hidden_pull`, `neighbor_partners`) against the Qloo Hackathon API (`https://hackathon.api.qloo.com`, `X-Api-Key`, server-side only).

## Run it yourself

```bash
printf 'QLOO_API_KEY=...\nGEMINI_API_KEY=...\n' > .dev.vars
npx wrangler@3 pages dev dist --kv KV
```

Deploy: `npx wrangler@3 pages deploy dist` with `QLOO_API_KEY` and `GEMINI_API_KEY` as Pages secrets and a KV namespace bound as `KV`.

## License

MIT — see `LICENSE`. Built for the Qloo Agentic Hackathon 2026.

## Tests

Recorded end-to-end runs against the live demo (three industries + two inputs that must be refused): see [`E2E_TESTS.md`](E2E_TESTS.md).
