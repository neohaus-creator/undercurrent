// Undercurrent — finds what a small business's customers love but never say, and turns it into marketing.
// Qloo supplies the taste graph; this file adds a "hidden pull" score (what rises for *these* customers
// but not for everyone), and Gemini turns the evidence into a playbook.

const QLOO = "https://hackathon.api.qloo.com";
const MODEL = "gemini-3.8-flash";
const PRICE_IN = 0.75 / 1e6;   // USD per input token
const PRICE_OUT = 3.75 / 1e6;  // USD per output token
const MAX_ROUNDS = 10;
const MIN_CATS = 4;     // categories with measured results required before the playbook

const CATEGORIES = {
  music: "urn:entity:artist",
  film: "urn:entity:movie",
  tv: "urn:entity:tv_show",
  brands: "urn:entity:brand",
  books: "urn:entity:book",
  podcasts: "urn:entity:podcast",
  travel: "urn:entity:destination",
};

const TOOLS = [{
  functionDeclarations: [
    {
      name: "find_entity",
      description: "Find the Qloo entity for a business, venue, brand, artist or title. Use for the user's own business and for any look-alikes they name.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string", enum: ["urn:entity:place", "urn:entity:brand", "urn:entity:artist", "urn:entity:movie", "urn:entity:tv_show", "urn:entity:book"] },
          city: { type: "string", description: "City to narrow a place search, e.g. 'Brooklyn, NY'" },
        },
        required: ["query", "type"],
      },
    },
    {
      name: "hidden_pull",
      description: "Core tool. For the customers of the seed entities, find what they love in another category that the general public does NOT especially love. " +
        "Returns items with affinity (how strongly they match) and, compared with the area's general top 200 for the same category, whether each item is hidden (absent from it) or popular locally (local_rank).",
      parameters: {
        type: "object",
        properties: {
          seed_ids: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: Object.keys(CATEGORIES) },
        },
        required: ["seed_ids", "category"],
      },
    },
    {
      name: "taste_keywords",
      description: "Get the taste keywords (Qloo tags) that best describe the seed entities' audience — the mood words for branding.",
      parameters: {
        type: "object",
        properties: { seed_ids: { type: "array", items: { type: "string" } } },
        required: ["seed_ids"],
      },
    },
    {
      name: "neighbor_partners",
      description: "Find nearby places whose audience overlaps with the seed's audience — candidates for collaborations and cross-promotion.",
      parameters: {
        type: "object",
        properties: {
          seed_ids: { type: "array", items: { type: "string" } },
          city: { type: "string" },
        },
        required: ["seed_ids", "city"],
      },
    },
  ],
}];

const SYSTEM = `You are Undercurrent, a marketing analyst for small businesses.
Your job: reveal what this business's customers are drawn to without knowing it — the cultural taste outside the business's own category — and turn it into concrete marketing.
Work like an agent:
1. find_entity for the business (and any look-alikes the owner names). If the business itself is not found, use the look-alikes as seeds and say so.
2. taste_keywords for the seeds.
3. hidden_pull for at least four categories (music, film or tv, brands, and one of books/podcasts/travel).
4. neighbor_partners if a city is known.
5. Write the playbook.
Rules:
- A seed must plausibly be the business or one of the named look-alikes (same name, or the same kind of business). If find_entity only returns unrelated things (a musical for a kimchi shop, a travel site for a random string), do NOT use them: stop and reply with exactly NO_MATCH.
- Use ONLY items returned by the tools. Never invent a name, number or partner.
- Each hidden_pull result says whether the item is hidden (not in the area's general top 200 for that category) or popular locally (local_rank). Prefer hidden items: those are the hidden pulls. Items with a local_rank are things everyone nearby likes — mention them only as "not distinctive". If baseline_available is false, say the local comparison was unavailable and do not call anything hidden.
- Quote the evidence briefly, e.g. "(affinity 0.82, not in Austin's top 200)" or "(affinity 0.80, #12 in Austin overall)".
- These are tastes Qloo associates with the business and its audience, not a survey of its actual buyers. Word it that way ("people drawn to places like yours"), never as measured facts about the owner's customers.
Playbook format, in plain text with short headings:
## Who your customers are (in one paragraph, from the keywords)
## The hidden pulls (5–8 items across categories, each with evidence and one line on why it matters)
## What to do this month (3–4 concrete actions: an event, a menu/product idea, a playlist, a collaboration)
## Ad targeting (interest keywords to paste into Meta/Pinterest ads)
## Three posts you can publish today (short, in the business's voice)`;

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

const entitiesOf = j => (j && j.results && (j.results.entities || j.results)) || [];

function slim(e) {
  if (!e || typeof e !== "object") return null;
  const p = e.properties || {};
  const img = p.image && (p.image.url || p.image);
  return {
    id: e.entity_id || e.id,
    name: e.name,
    affinity: e.query && typeof e.query.affinity === "number" ? Math.round(e.query.affinity * 100) / 100 : undefined,
    popularity: typeof e.popularity === "number" ? e.popularity : (typeof p.popularity === "number" ? p.popularity : undefined),
    why: e.query && e.query.explainability ? e.query.explainability : undefined,
    image: typeof img === "string" ? img : undefined,
    address: p.address || undefined,
  };
}

// Baseline = what Qloo ranks for this category for the area in general (no customer signal).
// Qloo needs at least one signal and caps take at 50, so the area is the neutral signal and we read
// BASE_PAGES pages (top 200). With only the top 50 almost nothing overlapped, so everything looked "hidden".
// Cached for a day per area. Any failed page -> no baseline -> no "hidden" claim.
const BASE_PAGES = 4;
async function baseline(env, type, area) {
  const where = area || "United States";
  const key = `base200:${type}:${where.toLowerCase()}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const pages = await Promise.all(Array.from({ length: BASE_PAGES }, (_, i) =>
    qloo(env, "/v2/insights", { "filter.type": type, "signal.location.query": where, take: 50, page: i + 1 })));
  if (pages.some(j => j.error)) return null;
  const ids = pages.flatMap(j => entitiesOf(j).map(e => e.entity_id || e.id)).filter(Boolean);
  if (!ids.length) return null;
  await env.KV.put(key, JSON.stringify(ids), { expirationTtl: 86400 });
  return ids;
}

const TOOL_IMPL = {
  async find_entity(env, { query, type, city }) {
    const j = await qloo(env, "/search", { query, types: type, take: 5, "filter.address": type === "urn:entity:place" ? city : undefined });
    if (j.error) return j;
    return { results: entitiesOf(j).map(slim).filter(Boolean) };
  },

  async hidden_pull(env, { seed_ids, category }, ctx = {}) {
    const type = CATEGORIES[category];
    if (!type) return { error: "unknown category" };
    const [j, base] = await Promise.all([
      qloo(env, "/v2/insights", { "filter.type": type, "signal.interests.entities": seed_ids, take: 30, "feature.explainability": "true" }),
      baseline(env, type, ctx.city),
    ]);
    if (j.error) return j;
    // popularity 0 = a thin, unverified record in the graph (e.g. a mass-market brand surfacing for a specialty roaster) — skip it
    const rows = entitiesOf(j).map(slim).filter(r => r && r.popularity !== 0);
    // Compare with the area's general top 200 for the same category. We report only what we measured:
    // hidden = not in that top 200; otherwise the item's local rank. No baseline -> no claim at all.
    const baseRank = new Map((base || []).map((id, i) => [id, i + 1]));
    const scored = rows.map((r, i) => ({
      ...r, rank: i + 1,
      local_rank: base ? (baseRank.get(r.id) || null) : undefined,
      hidden: base ? !baseRank.has(r.id) : null,
    }));
    if (base) scored.sort((a, b) => (b.hidden - a.hidden) || ((b.affinity || 0) - (a.affinity || 0)));
    // What the comparison removed: matches that are already popular with everyone in the area (shown as "not distinctive").
    const subtracted = base ? scored.filter(r => r.local_rank).map(r => ({ name: r.name, local_rank: r.local_rank, affinity: r.affinity })) : [];
    return { category, baseline_available: !!base, baseline_area: ctx.city || "United States", baseline_size: base ? base.length : 0,
             matched: scored.length, subtracted, results: scored.filter(r => !r.local_rank).slice(0, 8) };
  },

  async taste_keywords(env, { seed_ids }) {
    const j = await qloo(env, "/v2/insights", { "filter.type": "urn:tag", "signal.interests.entities": seed_ids, take: 15 });
    if (j.error) return j;
    const tags = (j.results && (j.results.tags || j.results.entities)) || [];
    return { keywords: tags.map(t => ({ name: t.name, type: t.subtype || t.type, affinity: t.query && t.query.affinity })).filter(t => t.name) };
  },

  async neighbor_partners(env, { seed_ids, city }) {
    const j = await qloo(env, "/v2/insights", {
      "filter.type": "urn:entity:place", "signal.interests.entities": seed_ids, "filter.location.query": city,
      "filter.exclude.entities": seed_ids, take: 10,
    });
    if (j.error) return j;
    return { results: entitiesOf(j).map(slim).filter(Boolean) };
  },
};

// ---------- guards: per-visitor limit + total budget ----------
async function guard(env, ip) {
  const day = new Date().toISOString().slice(0, 10);
  const spent = Number(await env.KV.get("spend_usd") || 0);
  if (spent >= Number(env.BUDGET_USD || 9)) return "The demo has used up its budget for now. Please try again later.";
  // Daily cap so one busy day can't eat the days the judges use.
  const spentToday = Number(await env.KV.get(`spend:${day}`) || 0);
  if (spentToday >= Number(env.DAILY_BUDGET_USD || 6)) return "The demo has reached today's budget. Please try again tomorrow (UTC), or use one of the examples — those are cached.";
  const k = `ip:${day}:${ip}`;
  const n = Number(await env.KV.get(k) || 0);
  if (n >= Number(env.PER_IP_DAY || 30)) return "Daily limit reached for this visitor. Please come back tomorrow.";
  await env.KV.put(k, String(n + 1), { expirationTtl: 172800 });
  return null;
}

async function addSpend(env, usd) {
  const cur = Number(await env.KV.get("spend_usd") || 0);
  await env.KV.put("spend_usd", (cur + usd).toFixed(6));
  const dk = `spend:${new Date().toISOString().slice(0, 10)}`;
  const today = Number(await env.KV.get(dk) || 0);
  await env.KV.put(dk, (today + usd).toFixed(6), { expirationTtl: 259200 });
}

// Same input within a day -> same answer from KV (no Qloo/Gemini cost; judges clicking the examples are free).
async function cacheKey(parts) {
  const raw = parts.map(s => s.toLowerCase().replace(/\s+/g, " ").trim()).join("|");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return "resp:" + [...new Uint8Array(h)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
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
      generationConfig: { temperature: 0.5, maxOutputTokens: 3072 },
    }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const business = String(body.business || "").slice(0, 200).trim();
  const city = String(body.city || "").slice(0, 100).trim();
  const alike = String(body.alike || "").slice(0, 300).trim();
  const note = String(body.note || "").slice(0, 600).trim();
  if (!business) return Response.json({ error: "Tell me the name of your business." }, { status: 400 });

  const ck = await cacheKey([business, city, alike, note]);
  const cached = await env.KV.get(ck, "json");
  if (cached) return Response.json({ ...cached, cached: true });

  const blocked = await guard(env, ip);
  if (blocked) return Response.json({ error: blocked }, { status: 429 });

  const ask = `My business: ${business}${city ? `, in ${city}` : ""}.` +
    (alike ? ` Places or brands like mine: ${alike}.` : "") + (note ? ` About us: ${note}` : "");
  const contents = [{ role: "user", parts: [{ text: ask }] }];
  const trace = [];
  const evidence = { keywords: [], pulls: {}, partners: [], seeds: [], baseline: {} };
  const ctx = { qlooOk: 0, qlooDown: false, nudged: false };
  let usd = 0;

  const done = async (payload, status = 200) => {
    await addSpend(env, usd);
    const out = { ...payload, trace, evidence };
    // Cache only finished playbooks; refusals and errors are retried fresh.
    if (status === 200 && payload.reply && payload.categories >= MIN_CATS) await env.KV.put(ck, JSON.stringify(out), { expirationTtl: 86400 });
    return Response.json(out, { status });
  };
  // One place that turns a tool result into trace + evidence (used for model calls and server top-ups alike).
  const record = (name, args, out) => {
    if (out.error) { if (/qloo (401|403|429|5\d\d)/.test(out.error)) ctx.qlooDown = true; }
    else ctx.qlooOk++;
    trace.push({ tool: name, args, count: (out.results || out.keywords || []).length, error: out.error });
    if (name === "find_entity" && out.results && out.results[0]) evidence.seeds.push(out.results[0]);
    if (name === "hidden_pull" && args.seed_ids && args.seed_ids.length && !out.error) ctx.seedIds = args.seed_ids;
    if (name === "hidden_pull" && out.results && out.results.length) evidence.pulls[out.category] = out.results;
    if (name === "hidden_pull" && out.category) evidence.baseline[out.category] = { available: out.baseline_available, area: out.baseline_area, size: out.baseline_size, matched: out.matched, subtracted: out.subtracted };
    if (name === "taste_keywords" && out.keywords) evidence.keywords = out.keywords;
    if (name === "neighbor_partners" && out.results) evidence.partners = out.results;
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await gemini(env, contents);
      const u = res.usageMetadata || {};
      usd += (u.promptTokenCount || 0) * PRICE_IN + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE_OUT;
      const parts = (res.candidates && res.candidates[0] && res.candidates[0].content && res.candidates[0].content.parts) || [];
      const calls = parts.filter(p => p.functionCall);

      if (!calls.length) {
        const have = Object.keys(evidence.pulls);
        // Enforce the minimum in code, not only in the prompt: at least four categories before writing.
        // 1st time: ask the model. 2nd time: the server measures the missing categories itself and hands them over.
        if (have.length && have.length < MIN_CATS && round < MAX_ROUNDS - 1) {
          const missing = Object.keys(CATEGORIES).filter(c => !have.includes(c));
          contents.push({ role: "model", parts });
          if (!ctx.nudgedCats) {
            ctx.nudgedCats = true;
            contents.push({ role: "user", parts: [{ text: `Not enough evidence yet. Run hidden_pull for: ${missing.slice(0, MIN_CATS - have.length).join(", ")}. Then write the playbook.` }] });
            continue;
          }
          if (!ctx.serverFilled && ctx.seedIds) {
            ctx.serverFilled = true;
            const added = [];
            for (const category of missing) {
              if (Object.keys(evidence.pulls).length >= MIN_CATS) break;
              const out = await TOOL_IMPL.hidden_pull(env, { seed_ids: ctx.seedIds, category }, { city });
              record("hidden_pull", { seed_ids: ctx.seedIds, category, by: "server" }, out);
              if (out.results && out.results.length) added.push(out);
            }
            contents.push({ role: "user", parts: [{ text: `The server measured these extra categories with the same seeds. Use them too, then write the full playbook:\n${JSON.stringify(added)}` }] });
            continue;
          }
        }
        if (!have.length) {
          // No Qloo evidence yet: the model may not answer from its own memory.
          if (!ctx.nudged && round < MAX_ROUNDS - 2) {
            ctx.nudged = true;
            contents.push({ role: "model", parts });
            contents.push({ role: "user", parts: [{ text: "Before writing anything, find the business with find_entity and run hidden_pull. Use only what Qloo returns." }] });
            continue;
          }
          return done({ error: "I couldn't find this business or anything like it in Qloo's taste graph, so I won't guess. Try adding one or two well-known places or brands like yours." }, 422);
        }
        const text = parts.map(p => p.text || "").join("").trim();
        if (text.startsWith("NO_MATCH")) {
          return done({ error: "Qloo couldn't find your business or anything clearly like it, so I won't guess. Try adding one or two well-known places or brands like yours." }, 422);
        }
        // Final gate: say plainly when fewer categories than the minimum had data, instead of passing it off as complete.
        const n = Object.keys(evidence.pulls).length;
        const note = n < MIN_CATS ? `\n\n_Note: Qloo returned data for only ${n} of the ${MIN_CATS} categories we require, so this playbook is thinner than usual._` : "";
        return done({ reply: text + note, categories: n });
      }

      contents.push({ role: "model", parts });
      const responses = [];
      for (const c of calls) {
        const { name, args = {} } = c.functionCall;
        const impl = TOOL_IMPL[name];
        const out = impl ? await impl(env, args, { city }) : { error: "unknown tool" };
        record(name, args, out);
        responses.push({ functionResponse: { name, response: out } });
      }
      contents.push({ role: "user", parts: responses });
      if (ctx.qlooDown && !ctx.qlooOk) {
        return done({ error: "The taste graph is unreachable right now, so I won't guess. Please try again in a minute." }, 503);
      }
    }
    if (!Object.keys(evidence.pulls).length) {
      return done({ error: "Qloo couldn't match your business well enough to measure anything, so I won't guess. Try adding one or two well-known places or brands like yours." }, 422);
    }
    return done({ reply: "I gathered the evidence but ran out of steps before writing the playbook. The measured findings are listed on the right." });
  } catch (e) {
    return done({ error: String(e.message || e) }, 502);
  }
}
