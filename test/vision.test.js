const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transcribe } = require("../vision");

test("visión envía PNG en memoria y conserva la indentación del OCR", async (context) => {
  const previous = process.env.GROQ_API_KEY;
  const previousMax = process.env.GROQ_MAX_COMPLETION_TOKENS;
  delete process.env.GROQ_MAX_COMPLETION_TOKENS;
  process.env.GROQ_API_KEY = "synthetic-test-key";
  context.after(() => {
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
    if (previousMax === undefined) delete process.env.GROQ_MAX_COMPLETION_TOKENS;
    else process.env.GROQ_MAX_COMPLETION_TOKENS = previousMax;
  });
  const png = Buffer.from("synthetic-image");
  const result = await transcribe(png, {
    fetchImpl: async (url, request) => {
      assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
      const body = JSON.parse(request.body);
      assert.equal(body.max_completion_tokens, 800);
      assert.equal(body.messages[1].content[1].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "  código\n    indentado" } }] }) };
    },
  });
  assert.equal(result, "  código\n    indentado");
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "length", message: { content: "cortado" } }] }) }),
  }), (error) => error.partialText === "cortado" && /Transcripción parcial/.test(error.message));
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Tokens per day exceeded" } }) }),
  }), /Límite de solicitudes/);
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => ({
      ok: false, status: 429,
      headers: { get: () => "60" },
      json: async () => ({ error: { message: "Tokens per day exceeded" } }),
    }),
  }), (error) => error.retryAfterMs === 60_000 && /Retry-After: 60.*Tokens per day exceeded/.test(error.message));
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Please try again in 35.94s." } }) }),
  }), (error) => error.retryAfterMs === 35_940);
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Request too large: expected output tokens exceed the enforced limit" } }) }),
  }), (error) => error.retryAfterMs === undefined);
  process.env.GROQ_MAX_COMPLETION_TOKENS = "500";
  await transcribe(png, {
    fetchImpl: async (_url, request) => {
      assert.equal(JSON.parse(request.body).max_completion_tokens, 500);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "texto" } }] }) };
    },
  });
  process.env.GROQ_MAX_COMPLETION_TOKENS = "-1";
  await assert.rejects(transcribe(png, {
    fetchImpl: async () => { assert.fail("Una configuración inválida no debe llamar a Groq"); },
  }), /entero positivo/);
});
