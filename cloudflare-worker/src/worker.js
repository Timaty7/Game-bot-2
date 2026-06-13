const ADMIN_IDS = new Set([id]);
const MAX_TELEGRAM_MESSAGE = 3900;
const memoryLogs = [];

const SYSTEM_PROMPT = [
  "You are Gidai Bot, a smart Telegram assistant.",
  "Reply in Kazakh when possible, but match the user's language if they use Russian or English.",
  "Be clear, practical, warm, and concise.",
  "Do not use Markdown formatting characters.",
].join(" ");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}


function getUser(message) {
  return {
    id: message.from?.id || message.chat?.id || 0,
    username: message.from?.username || "",
    firstName: message.from?.first_name || "",
  };
}

function isAdmin(message) {
  return ADMIN_IDS.has(getUser(message).id);
}

async function telegram(token, method, payload) {
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  if (!body.ok) {
    throw new Error(body.description || `Telegram ${method} failed.`);
  }

  return body.result;
}

async function sendMessage(env, chatId, text) {
  return telegram(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: cleanText(text).slice(0, MAX_TELEGRAM_MESSAGE) || "Bos jauap.",
  });
}

async function sendChatAction(env, chatId, action = "typing") {
  return telegram(env.TELEGRAM_BOT_TOKEN, "sendChatAction", {
    chat_id: chatId,
    action,
  });
}

function getAiText(result) {
  if (typeof result === "string") return result;
  if (typeof result?.response === "string") return result.response;
  if (typeof result?.result?.response === "string") return result.result.response;
  if (Array.isArray(result?.choices) && result.choices[0]?.message?.content) {
    return result.choices[0].message.content;
  }
  return "AI jauap formatyn tusine almadym.";
}

async function askAi(env, userText, mode = "assistant") {
  if (!env.AI) {
    return "AI binding kosylmagan. Cloudflare Worker config tekser.";
  }

  const systemPrompt =
    mode === "magic"
      ? [
          SYSTEM_PROMPT,
          "Special mode: give 3 unusual ideas, 1 concrete next step, and 1 ready Telegram post.",
        ].join(" ")
      : SYSTEM_PROMPT;

  const result = await env.AI.run(env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    max_tokens: mode === "magic" ? 450 : 350,
  });

  return cleanText(getAiText(result));
}

async function getStats(env) {
  if (!env.BOT_LOGS) {
    return { totalMessages: memoryLogs.length, lastIds: [] };
  }

  const stored = await env.BOT_LOGS.get("stats", "json");
  return stored || { totalMessages: 0, lastIds: [] };
}

async function saveLog(env, message, aiAnswer) {
  const user = getUser(message);
  const id = `${Date.now()}-${message.message_id || crypto.randomUUID()}`;
  const row = {
    id,
    date: new Date().toISOString(),
    userId: user.id,
    username: user.username,
    firstName: user.firstName,
    question: message.text || "",
    answer: aiAnswer || "",
  };

  if (!env.BOT_LOGS) {
    memoryLogs.unshift(row);
    memoryLogs.splice(5);
    return;
  }

  await env.BOT_LOGS.put(`msg:${id}`, JSON.stringify(row));

  const stats = await getStats(env);
  stats.totalMessages = Number(stats.totalMessages || 0) + 1;
  stats.lastIds = [id, ...(stats.lastIds || [])].slice(0, 5);

  await env.BOT_LOGS.put("stats", JSON.stringify(stats));
}

async function getLastMessages(env) {
  if (!env.BOT_LOGS) {
    return memoryLogs;
  }

  const stats = await getStats(env);
  const rows = [];

  for (const id of stats.lastIds || []) {
    const row = await env.BOT_LOGS?.get(`msg:${id}`, "json");
    if (row) rows.push(row);
  }

  return rows;
}

async function answerAdminPanel(env, message) {
  if (!isAdmin(message)) {
    await sendMessage(env, message.chat.id, "Sizde admin-panelge ruqsat joq.");
    return;
  }

  await sendMessage(
    env,
    message.chat.id,
    [
      "Admin-panel",
      "",
      "/stats - statistika",
      "/last - songgy habarlar",
      "/id - oz Telegram ID koru",
    ].join("\n"),
  );
}

async function answerStats(env, message) {
  if (!isAdmin(message)) return;

  const stats = await getStats(env);
  await sendMessage(env, message.chat.id, `Keste ishindegi habarlar sany: ${stats.totalMessages || 0}`);
}

async function answerLastMessages(env, message) {
  if (!isAdmin(message)) return;

  const rows = await getLastMessages(env);

  if (!rows.length) {
    await sendMessage(env, message.chat.id, "Ali habar saqtalmagan.");
    return;
  }

  const text = rows
    .map((row) =>
      [
        `Data: ${row.date}`,
        `User: ${row.username || "-"} / ${row.firstName || "-"}`,
        `Suraq: ${row.question || "-"}`,
        "",
      ].join("\n"),
    )
    .join("\n");

  await sendMessage(env, message.chat.id, `Songgy habarlar:\n\n${text}`);
}

async function handleMessage(env, message) {
  const chatId = message.chat?.id;
  const text = typeof message.text === "string" ? message.text.trim() : "";

  if (!chatId || !text) {
    return;
  }

  if (text === "/start") {
    await sendMessage(
      env,
      chatId,
      [
        "Salem! Men 24/7 cloud-ta jumys isteitin AI botpyn.",
        "",
        "Komandalar:",
        "/ai suragyn",
        "/magic taqyryp",
        "/id",
        "",
        "Admin:",
        "/admin",
      ].join("\n"),
    );
    return;
  }

  if (text === "/help") {
    await sendMessage(env, chatId, "Komandalar: /start, /ai, /magic, /id, /admin, /stats, /last.");
    return;
  }

  if (text === "/admin") {
    await answerAdminPanel(env, message);
    return;
  }

  if (text === "/id") {
    await sendMessage(env, chatId, `Sizdin Telegram ID: ${getUser(message).id}`);
    return;
  }

  if (text === "/stats") {
    await answerStats(env, message);
    return;
  }

  if (text === "/last") {
    await answerLastMessages(env, message);
    return;
  }

  await sendChatAction(env, chatId);

  const prompt = text.startsWith("/ai ") ? text.slice(4).trim() : text;
  const mode = text.startsWith("/magic ") ? "magic" : "assistant";
  const userPrompt = text.startsWith("/magic ") ? text.slice(7).trim() : prompt;

  let aiAnswer;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      aiAnswer = await askAi(env, userPrompt, mode);
      await saveLog(env, message, aiAnswer);
      await sendMessage(env, chatId, aiAnswer);
      return;
    } catch (error) {
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        continue;
      }

      console.error(`AI error: ${error.message}`);
      await sendMessage(
        env,
        chatId,
        "Keshiriniz, AI qazir jauap bere almady. Bir minutten kein qaitalap koriniz.",
      );
      return;
    }
  }
}

async function handleTelegramWebhook(request, env) {
  let update;

  try {
    update = await request.json();
  } catch {
    return json({ ok: true, ignored: "invalid-json" });
  }

  try {
    if (update.message) {
      await handleMessage(env, update.message);
    }
  } catch (error) {
    console.error(`Telegram update failed: ${error.message}`);
  }

  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "gidai-telegram-bot", storage: Boolean(env.BOT_LOGS) });
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      return handleTelegramWebhook(request, env);
    }

    return json({
      ok: true,
      message: "Telegram bot worker is running.",
      endpoints: ["GET /health", "POST /telegram"],
    });
  },
};
