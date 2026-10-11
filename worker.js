// Fit Track – Gemini proxy (Cloudflare Worker)
// Ortam değişkenleri (Settings → Variables):
//   GEMINI_API_KEY  (Secret)  : aistudio.google.com'dan alınan ücretsiz anahtar
//   ALLOWED_ORIGIN  (Text)    : ör. https://kullaniciadi.github.io  (virgülle birden fazla yazılabilir)
//   MODELS          (Text, opsiyonel) : sırayla denenecek modeller, ör. "gemini-flash-latest,gemini-flash-lite-latest"

const DEFAULT_MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "*").split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes("*") || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? (origin || "*") : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "Sadece POST kabul edilir" }, 405, cors);
    if (!okOrigin) return json({ error: "Bu adresten erişim izni yok (ALLOWED_ORIGIN)" }, 403, cors);
    if (!env.GEMINI_API_KEY) return json({ error: "Worker'da GEMINI_API_KEY tanımlı değil" }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Geçersiz istek" }, 400, cors); }
    const { system, prompt } = body || {};
    const temperature = Math.min(Math.max(Number(body?.temperature ?? 0.4), 0), 1.5);
    if (!prompt || typeof prompt !== "string" || prompt.length > 40000) {
      return json({ error: "Geçersiz prompt" }, 400, cors);
    }

    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: "application/json" }
    };
    if (system) payload.systemInstruction = { parts: [{ text: String(system).slice(0, 10000) }] };

    const models = (env.MODELS ? env.MODELS.split(",") : DEFAULT_MODELS).map(s => s.trim()).filter(Boolean);
    let lastErr = "";
    for (const model of models) {
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify(payload)
          }
        );
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          lastErr = `${model}: ${r.status} ${data?.error?.message || ""}`.trim();
          continue; // kota dolduysa (429) veya model yoksa sıradakini dene
        }
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
        if (!text) { lastErr = `${model}: boş yanıt`; continue; }
        return json({ model, text }, 200, cors);
      } catch (e) {
        lastErr = `${model}: ${e.message}`;
      }
    }
    const quota = /429|quota|RESOURCE_EXHAUSTED/i.test(lastErr);
    return json({
      error: quota
        ? "Ücretsiz yapay zeka kotası şu an dolu. Birkaç dakika sonra tekrar dene."
        : "Yapay zeka şu an yanıt vermiyor. " + lastErr
    }, 502, cors);
  }
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
  });
}
