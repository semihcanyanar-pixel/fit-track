// Fit Track – Gemini proxy (Cloudflare Worker)
// Ortam değişkenleri (Settings → Variables):
//   GEMINI_API_KEY  (Secret)  : aistudio.google.com'dan alınan ücretsiz anahtar
//   ALLOWED_ORIGIN  (Text)    : ör. https://kullaniciadi.github.io  (virgülle birden fazla yazılabilir)
//   FDC_API_KEY     (Secret, opsiyonel) : api.data.gov'dan ücretsiz USDA FoodData Central anahtarı (besin değerleri)
// Bağlantı (Settings → Bindings):
//   AI (Workers AI) : Google yoğun olduğunda devreye giren yedek yapay zeka (ücretsiz günlük kota)

// mode "fast": kalori hesaplama gibi kısa işler → hızlı Lite modeller önce, düşünme kapalı
// mode "deep": program/gün değerlendirme → gemini-flash-latest ölçümde 40 sn takılıp zaman aşımına uğradığı için lite önce
const MODELS = {
  fast: ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"],
  deep: ["gemini-3.1-flash-lite", "gemini-flash-latest", "gemini-flash-lite-latest"]
};
const CALL_TIMEOUT = { fast: 16000, deep: 25000 };   // tek Gemini denemesi için üst sınır
const TOTAL_BUDGET = { fast: 24000, deep: 45000 };  // Gemini için toplam süre; dolunca yedeğe geçilir
// Yedek: Cloudflare Workers AI (Gemini hepsi yoğun/kotalıysa)
const CF_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];
const CF_VISION = ["@cf/meta/llama-4-scout-17b-16e-instruct", "@cf/meta/llama-3.2-11b-vision-instruct"];   // fotoğraflı istekler için yedek

// Kimlik doğrulama: istemci Firebase ID token'ını "Authorization: Bearer ..." ile yollar.
// REQUIRE_AUTH = "1" (Text değişkeni) ise tokensız/geçersiz istekler 401 alır; tanımsızsa token varsa doğrulanır ama zorunlu değildir.
//   FIREBASE_PROJECT_ID (Text, opsiyonel) : varsayılan aşağıdaki proje
const FIREBASE_PROJECT = "fit-track-8b38d";
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache = { keys: null, at: 0 };
async function getJwks() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600000) return jwksCache.keys;
  const r = await fetch(JWKS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!r.ok) throw new Error("anahtarlar alınamadı");
  jwksCache = { keys: (await r.json()).keys || [], at: Date.now() };
  return jwksCache.keys;
}
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
async function verifyToken(token, projectId) {
  const [h, p, s] = String(token || "").split(".");
  if (!h || !p || !s) throw new Error("biçim");
  const head = JSON.parse(new TextDecoder().decode(b64u(h)));
  const pay = JSON.parse(new TextDecoder().decode(b64u(p)));
  const now = Date.now() / 1000;
  if (head.alg !== "RS256") throw new Error("algoritma");
  if (pay.aud !== projectId || pay.iss !== `https://securetoken.google.com/${projectId}`) throw new Error("proje");
  if (!pay.sub || pay.exp < now || pay.iat > now + 300) throw new Error("süre");
  const jwk = (await getJwks()).find(k => k.kid === head.kid);
  if (!jwk) throw new Error("anahtar");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(`${h}.${p}`))) throw new Error("imza");
  return pay.sub;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes("*") || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? (origin || "*") : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "Sadece POST kabul edilir" }, 405, cors);
    if (!okOrigin) return json({ error: "Bu adresten erişim izni yok (ALLOWED_ORIGIN)" }, 403, cors);
    const bearer = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/);
    let uid = null;
    if (bearer) { try { uid = await verifyToken(bearer[1], env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT); } catch (e) { uid = null; } }
    if (!uid && env.REQUIRE_AUTH === "1") return json({ kind: "auth", error: "Oturum doğrulanamadı. Çıkış yapıp tekrar giriş yap." }, 401, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "Worker'da GEMINI_API_KEY tanımlı değil" }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Geçersiz istek" }, 400, cors); }
    if (Array.isArray(body?.fdc)) return json(await fdcLookup(body.fdc.slice(0, 15), env), 200, cors);
    const { system, prompt } = body || {};
    const mode = body?.mode === "deep" ? "deep" : "fast";
    const temperature = Math.min(Math.max(Number(body?.temperature ?? 0.4), 0), 1.5);
    if (!prompt || typeof prompt !== "string" || prompt.length > 40000) return json({ error: "Geçersiz prompt" }, 400, cors);
    // İsteğe bağlı fotoğraf: { mime: "image/jpeg", data: "<base64>" }
    const image = body?.image && typeof body.image.data === "string" ? body.image : null;
    if (image && (!/^image\/(jpeg|png|webp|heic|heif)$/.test(image.mime || "") || image.data.length > 6_000_000)) return json({ error: "Fotoğraf çok büyük ya da desteklenmiyor" }, 400, cors);

    const parts = image ? [{ inlineData: { mimeType: image.mime, data: image.data } }, { text: prompt }] : [{ text: prompt }];
    const base = { contents: [{ role: "user", parts }], generationConfig: { temperature, responseMimeType: "application/json" } };
    if (system) base.systemInstruction = { parts: [{ text: String(system).slice(0, 10000) }] };

    const started = Date.now();
    let lastErr = "", busy = 0, quota = 0;
    const tried = [];                                // teşhis: denenen modeller, durum ve süre (ms)
    for (const model of MODELS[mode]) {
      let thinkingOff = mode === "fast";            // hızlı işlerde düşünmeyi kapat
      for (let attempt = 0; attempt < 2; attempt++) {
        const left = TOTAL_BUDGET[mode] - (Date.now() - started);
        if (left < 2500) break;
        const payload = structuredClone(base);
        if (thinkingOff) payload.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), Math.min(CALL_TIMEOUT[mode], left));
        const t1 = Date.now();
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: "POST", signal: ctl.signal,
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify(payload)
          });
          const data = await r.json().catch(() => ({}));
          tried.push({ m: model, s: r.status, ms: Date.now() - t1, e: r.ok ? undefined : String(data?.error?.message || "").slice(0, 150) });
          if (!r.ok) {
            const msg = data?.error?.message || "";
            lastErr = `${model}: ${r.status} ${msg}`.trim();
            // 400: bu model düşünmeyi kapatma ayarını kabul etmiyor olabilir (mesaj her zaman "think" demiyor); ayarsız tekrar dene
            if (r.status === 400 && thinkingOff) { thinkingOff = false; attempt--; continue; }
            if (r.status === 503 || r.status === 500) {
              busy++;
              // Yoğunluk çoğu zaman anlıktır: kısa bekleyip aynı modeli bir kez daha dene
              if (attempt === 0 && TOTAL_BUDGET[mode] - (Date.now() - started) > 6000) { await new Promise(res => setTimeout(res, 1500)); continue; }
            }
            if (r.status === 429) quota++;
            break;                                   // beklemeden sıradaki modele geç
          }
          const parts = data?.candidates?.[0]?.content?.parts || [];
          const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
          if (!text) { lastErr = `${model}: boş yanıt`; break; }
          return json({ model, text, ms: Date.now() - started, tried }, 200, cors);
        } catch (e) {
          tried.push({ m: model, s: e.name === "AbortError" ? "timeout" : "err", ms: Date.now() - t1 });
          lastErr = `${model}: ${e.name === "AbortError" ? "zaman aşımı" : e.message}`;
          if (e.name === "AbortError") busy++;
          break;
        } finally { clearTimeout(timer); }
      }
    }
    // ---- Yedek sağlayıcı: Cloudflare Workers AI ----
    if (env.AI && image) {
      const sys = (system ? String(system).slice(0, 10000) + "\n" : "") + "Yanıtın SADECE geçerli JSON olsun; açıklama, markdown veya ``` ekleme.";
      const dataUrl = `data:${image.mime};base64,${image.data}`;
      for (const m of CF_VISION) {
        const t2 = Date.now();
        try {
          let out;
          if (m.includes("llama-4")) {
            out = await env.AI.run(m, { messages: [{ role: "system", content: sys }, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }], max_tokens: 3000, temperature: 0.2 });
          } else {
            const bytes = [...Uint8Array.from(atob(image.data), c => c.charCodeAt(0))];
            const run = () => env.AI.run(m, { messages: [{ role: "system", content: sys }, { role: "user", content: prompt }], image: bytes, max_tokens: 3000, temperature: 0.2 });
            try { out = await run(); }
            catch (e) { if (/agree|licen/i.test(e.message)) { await env.AI.run(m, { prompt: "agree" }); out = await run(); } else throw e; }
          }
          const text = typeof out?.response === "string" ? out.response : out?.response ? JSON.stringify(out.response) : "";
          tried.push({ m, s: text ? 200 : "empty", ms: Date.now() - t2 });
          if (text && /[{[]/.test(text)) return json({ model: m, text, ms: Date.now() - started, fallback: true, tried }, 200, cors);
          lastErr += ` | ${m}: boş yanıt`;
        } catch (e) { tried.push({ m, s: "err", ms: Date.now() - t2 }); lastErr += ` | ${m}: ${e.message}`; }
      }
    }
    if (env.AI && !image) {
      const messages = [
        { role: "system", content: (system ? String(system).slice(0, 10000) + "\n" : "") + "Yanıtın SADECE geçerli JSON olsun; açıklama, markdown veya ``` ekleme." },
        { role: "user", content: prompt }
      ];
      for (const m of CF_MODELS) {
        const t2 = Date.now();
        try {
          const out = await env.AI.run(m, { messages, max_tokens: mode === "deep" ? 4000 : 3000, temperature: Math.min(temperature, 1) });
          let text = typeof out?.response === "string" ? out.response : out?.response ? JSON.stringify(out.response) : "";
          tried.push({ m, s: text ? 200 : "empty", ms: Date.now() - t2 });
          if (text && /[{[]/.test(text)) return json({ model: m, text, ms: Date.now() - started, fallback: true, tried }, 200, cors);
          lastErr += ` | ${m}: boş yanıt`;
        } catch (e) { tried.push({ m, s: "err", ms: Date.now() - t2 }); lastErr += ` | ${m}: ${e.message}`; }
      }
    }
    const kind = busy ? "busy" : quota ? "quota" : "error";
    return json({
      kind,
      detail: lastErr.slice(0, 600),
      tried,
      error: kind === "busy" ? "Yapay zeka sunucuları şu an çok yoğun" + (env.AI ? "." : " (yedek yapay zeka bağlı değil).")
        : kind === "quota" ? "Ücretsiz yapay zeka kotası şu an dolu. Birkaç dakika sonra tekrar dene."
        : "Yapay zeka şu an yanıt vermiyor. " + lastErr
    }, 502, cors);
  }
};

// USDA FoodData Central: 100 g başına kcal / protein / karbonhidrat / yağ
const NUT = { kcal: [1008, 2047, 2048], p: [1003], c: [1005, 1050], f: [1004, 1085] };
async function fdcLookup(list, env) {
  if (!env.FDC_API_KEY) return { error: "nokey", items: [] };
  const cache = caches.default;
  const one = async q => {
    q = String(q || "").trim().toLowerCase().slice(0, 80);
    if (!q) return null;
    const ck = new Request("https://fdc-cache.local/v2/" + encodeURIComponent(q));
    const hit = await cache.match(ck).catch(() => null);
    if (hit) return hit.json();
    const url = `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${env.FDC_API_KEY}&query=${encodeURIComponent(q)}&dataType=${encodeURIComponent("Foundation,SR Legacy")}&pageSize=8`;
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) return null;
      const d = await r.json();
      const words = q.split(/[\s,]+/).filter(Boolean);
      const pick = (d.foods || []).map(fd => {
        const val = ids => { for (const id of ids) { const n = (fd.foodNutrients || []).find(x => x.nutrientId === id || +x.nutrientNumber === id); if (n && n.value != null) return +n.value; } return null; };
        const desc = String(fd.description || "").toLowerCase();
        const score = words.filter(x => desc.includes(x)).length * 10 - desc.split(",").length + (fd.dataType === "SR Legacy" ? 1 : 0) - (/powder|dried|dehydrated|frozen|canned/.test(desc) && !/powder|dried|dehydrated|frozen|canned/.test(q) ? 30 : 0);
        return { score, ad: fd.description, id: fd.fdcId, kcal100: val(NUT.kcal), p100: val(NUT.p), c100: val(NUT.c), f100: val(NUT.f) };
      }).filter(x => x.kcal100 != null && x.p100 != null).sort((a, b) => b.score - a.score)[0] || null;
      const out = pick ? { q, ad: pick.ad, id: pick.id, kcal100: pick.kcal100, p100: pick.p100, c100: pick.c100 ?? 0, f100: pick.f100 ?? 0 } : { q, none: true };
      await cache.put(ck, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=2592000", "Content-Type": "application/json" } })).catch(() => {});
      return out;
    } catch { return null; } finally { clearTimeout(to); }
  };
  return { items: await Promise.all(list.map(one)) };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
}
