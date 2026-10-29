// Seoulmate — a taste-aware K-drama guide agent.
// Gemini plans and talks; Qloo's taste graph decides what matches; kdramahistory.com explains why it matters.
import EXPLAINERS from "../_data/explainers.js";
import SHOW_MAP from "../_data/show_map.js";

const QLOO = "https://hackathon.api.qloo.com";
const MODEL = "gemini-3.8-flash";
const PRICE_IN = 0.75 / 1e6;   // USD per input token
const PRICE_OUT = 3.75 / 1e6;  // USD per output token
const MAX_ROUNDS = 6;

const TOOLS = [{
  functionDeclarations: [
    {
      name: "search_entities",
      description: "Find Qloo entity IDs by name. Use for every show, film, artist, book or place the user mentions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string", enum: ["urn:entity:tv_show", "urn:entity:movie", "urn:entity:artist", "urn:entity:book", "urn:entity:place", "urn:entity:brand", "urn:entity:video_game", "urn:entity:podcast"] },
        },
        required: ["query", "type"],
      },
    },
    {
      name: "recommend",
      description: "Ask Qloo's taste graph for entities that people with the given tastes love. " +
        "scope='library' ranks only the K-dramas we have history explainers for (always try this first for dramas). " +
        "scope='korea' ranks any Korean-made title. scope='any' is unrestricted.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["urn:entity:tv_show", "urn:entity:movie", "urn:entity:artist", "urn:entity:place", "urn:entity:book"] },
          seed_ids: { type: "array", items: { type: "string" }, description: "Qloo entity IDs from search_entities" },
          scope: { type: "string", enum: ["library", "korea", "any"] },
          tag_query: { type: "string", description: "Optional tag text, e.g. 'korean' for cuisine or 'k-pop' for music" },
          location: { type: "string", description: "Optional city for places, e.g. 'London'" },
          take: { type: "integer" },
        },
        required: ["type", "seed_ids", "scope"],
      },
    },
    {
      name: "get_explainers",
      description: "Get our sourced history explainers (kdramahistory.com) for K-drama titles.",
      parameters: {
        type: "object",
        properties: { shows: { type: "array", items: { type: "string" } } },
        required: ["shows"],
      },
    },
  ],
}];

const SYSTEM = `You are Seoulmate, a guide who turns someone's existing taste into a first course in Korean drama and culture.
Work like an agent:
1. Call search_entities for each title, artist or food the user names (pick the right type).
2. Call recommend with those IDs: first type=tv_show scope=library, then scope=korea if the library gives fewer than 3.
3. Call get_explainers for the dramas you pick.
4. Optionally recommend Korean food (type=place, tag_query='korean', location if the user gave a city) and music (type=artist, scope=korea).
Rules: only recommend titles that came back from recommend. Never invent history — use only explainer titles/descriptions returned by get_explainers, and cite their URLs. Say why each pick fits the user's taste in one plain sentence.
Finish with plain text in this order: a one-line read of their taste; 3 drama picks (each: title, why it fits, the history behind it with the explainer link); then food and music if found; then one next step.`;

// ---------- Qloo ----------
async function qloo(env, path, params) {
  const u = new URL(QLOO + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length)) continue;
    u.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const r = await fetch(u, { headers: { "X-Api-Key": env.QLOO_API_KEY } });
  if (!r.ok) return { error: `qloo ${r.status}`, detail: (await r.text()).slice(0, 300) };
  return r.json();
}

function slim(e) {
  if (!e) return null;
  const p = e.properties || {};
  return {
    id: e.entity_id || e.id,
    name: e.name,
    year: p.release_year || p.year || undefined,
    image: (p.image && (p.image.url || p.image)) || undefined,
    affinity: e.query && typeof e.query.affinity === "number" ? Math.round(e.query.affinity * 100) / 100 : undefined,
    address: p.address || undefined,
  };
}

async function tagIds(env, text) {
  const j = await qloo(env, "/v2/tags", { "filter.query": text, take: 5 });
  const tags = (j.results && (j.results.tags || j.results)) || [];
  return Array.isArray(tags) ? tags.map(t => t.id || t.tag_id).filter(Boolean).slice(0, 3) : [];
}

const TOOL_IMPL = {
  async search_entities(env, { query, type }) {
    const j = await qloo(env, "/search", { query, types: type, take: 5 });
    if (j.error) return j;
    return { results: (j.results || []).map(slim).filter(Boolean) };
  },

  async recommend(env, { type, seed_ids, scope, tag_query, location, take }) {
    const params = { "filter.type": type, "signal.interests.entities": seed_ids, take: Math.min(take || 6, 10) };
    if (scope === "library" && type === "urn:entity:tv_show") {
      params["filter.results.entities"] = Object.values(SHOW_MAP).filter(Boolean);
    } else if (scope === "korea" && (type === "urn:entity:tv_show" || type === "urn:entity:movie")) {
      params["filter.release_country"] = "South Korea";
    }
    if (tag_query) params["filter.tags"] = await tagIds(env, tag_query);
    if (location && type === "urn:entity:place") params["filter.geocode.name"] = location;
    const j = await qloo(env, "/v2/insights", params);
    if (j.error) return j;
    const ents = (j.results && j.results.entities) || [];
    return { results: ents.map(slim).filter(Boolean) };
  },

  async get_explainers(_env, { shows }, ctx) {
    // Grounding rule enforced in code: only dramas that Qloo actually returned may be explained.
    if (!ctx.allowed.size) return { error: "Call recommend first — only dramas returned by Qloo can be explained." };
    const want = shows.map(s => s.toLowerCase()).filter(w => [...ctx.allowed].some(a => a.includes(w) || w.includes(a)));
    if (!want.length) return { error: "None of these titles came from Qloo's recommendations.", allowed: [...ctx.allowed] };
    const hits = EXPLAINERS.filter(x => x.show && want.some(w => x.show.toLowerCase().includes(w) || w.includes(x.show.toLowerCase())));
    return {
      explainers: hits.slice(0, 8).map(x => ({ show: x.show, title: x.title, era: x.era, about: x.description, url: x.url, cover: x.cover })),
    };
  },
};

// ---------- guards: per-visitor limit + total budget ----------
async function guard(env, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const spent = Number(await env.KV.get("spend_usd") || 0);
  if (spent >= Number(env.BUDGET_USD || 9)) return "The demo has used up its budget for now. Please try again later.";
  const k = `ip:${day}:${ip}`;
  const n = Number(await env.KV.get(k) || 0);
  if (n >= Number(env.PER_IP_DAY || 30)) return "Daily limit reached for this visitor. Please come back tomorrow.";
  await env.KV.put(k, String(n + 1), { expirationTtl: 172800 });
  return null;
}

async function addSpend(env, usd) {
  const cur = Number(await env.KV.get("spend_usd") || 0);
  await env.KV.put("spend_usd", (cur + usd).toFixed(6));
}

// ---------- Gemini agent loop ----------
async function gemini(env, contents) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents,
      tools: TOOLS,
      generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const blocked = await guard(env, ip);
  if (blocked) return Response.json({ error: blocked }, { status: 429 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const message = String(body.message || "").slice(0, 1500);
  if (!message.trim()) return Response.json({ error: "empty message" }, { status: 400 });

  const contents = [{ role: "user", parts: [{ text: message }] }];
  const trace = [];
  const cards = { dramas: [], explainers: [], places: [], artists: [] };
  const ctx = { allowed: new Set(), qlooDown: false };
  let usd = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await gemini(env, contents);
      const u = res.usageMetadata || {};
      usd += (u.promptTokenCount || 0) * PRICE_IN + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE_OUT;
      const parts = (res.candidates && res.candidates[0] && res.candidates[0].content && res.candidates[0].content.parts) || [];
      const calls = parts.filter(p => p.functionCall);
      if (!calls.length && !ctx.allowed.size) {
        // No Qloo-backed picks yet: do not let the model answer from its own memory.
        if (round < MAX_ROUNDS - 2 && !ctx.nudged) {
          ctx.nudged = true;
          contents.push({ role: "model", parts });
          contents.push({ role: "user", parts: [{ text: "Before answering, call search_entities for my favourites and then recommend (type=urn:entity:tv_show). Only recommend what Qloo returns." }] });
          continue;
        }
        await addSpend(env, usd);
        return Response.json({ error: "I couldn't get taste matches from Qloo for that, so I won't guess. Try naming two or three specific titles.", trace, cards }, { status: 422 });
      }
      if (!calls.length) {
        const text = parts.map(p => p.text || "").join("").trim();
        await addSpend(env, usd);
        return Response.json({ reply: text, trace, cards });
      }
      contents.push({ role: "model", parts });
      const responses = [];
      for (const c of calls) {
        const { name, args } = c.functionCall;
        const impl = TOOL_IMPL[name];
        const out = impl ? await impl(env, args || {}, ctx) : { error: "unknown tool" };
        if (name === "recommend" && out.results && args.type === "urn:entity:tv_show") out.results.forEach(r => r.name && ctx.allowed.add(r.name.toLowerCase()));
        if (out.error && /qloo (401|403|5\d\d)/.test(out.error)) ctx.qlooDown = true;
        trace.push({ tool: name, args, count: (out.results || out.explainers || []).length, error: out.error });
        if (name === "recommend" && out.results) {
          const bucket = args.type === "urn:entity:tv_show" ? "dramas" : args.type === "urn:entity:place" ? "places" : args.type === "urn:entity:artist" ? "artists" : null;
          if (bucket) cards[bucket].push(...out.results);
        }
        if (name === "get_explainers" && out.explainers) cards.explainers.push(...out.explainers);
        responses.push({ functionResponse: { name, response: out } });
      }
      contents.push({ role: "user", parts: responses });
      if (ctx.qlooDown) {
        await addSpend(env, usd);
        return Response.json({ error: "The taste graph is unreachable right now, so I won't guess. Please try again in a minute.", trace, cards }, { status: 503 });
      }
    }
    await addSpend(env, usd);
    return Response.json({ reply: "I gathered a lot but ran out of steps — try naming two or three favourites.", trace, cards });
  } catch (e) {
    await addSpend(env, usd);
    return Response.json({ error: String(e.message || e), trace }, { status: 502 });
  }
}
