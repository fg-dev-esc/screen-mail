const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

async function main() {
  const env = parseEnv(fs.readFileSync(path.join(__dirname, "../.env"), "utf8"));
  if (!env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env.");
  const response = await fetch("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  const headers = Object.fromEntries([...response.headers].filter(([key]) => key.startsWith("x-ratelimit") || key === "retry-after"));
  console.log(JSON.stringify({
    status: response.status,
    rateLimitHeaders: headers,
    selectedModel: data.data?.find((model) => model.id === (env.GROQ_VISION_MODEL || "qwen/qwen3.8-27b")),
    availableModels: data.data?.map((model) => model.id),
    error: data.error,
  }, null, 2));
  if (!response.ok) process.exitCode = 1;
  console.log("Los límites del modelo no son las cuotas de la organización. Cuotas exactas: https://console.groq.com/settings/limits");
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
