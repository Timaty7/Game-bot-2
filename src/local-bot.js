import { createSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "./env.js";

loadEnvFile();

const config = {
  token: process.env.TELEGRAM_BOT_TOKEN || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  adminIds: (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => Number.parseInt(id.trim(), 10))
    .filter(Number.isFinite),
  sheetId: process.env.SHEET_ID || "",
  sheetName: process.env.SHEET_NAME || "Sheet1",
  googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || "credentials.json",
};

const state = {
  offset: 0,
  guessGames: new Map(),
  quizGames: new Map(),
  accessToken: null,
  accessTokenExpiresAt: 0,
};

const dataPath = join(process.cwd(), "local-bot-data.json");

const games = {
  challenges: [
    "Мини-челлендж: за 10 минут наведи порядок на рабочем месте.",
    "Мини-челлендж: напиши одну сильную цель на сегодня и первый шаг к ней.",
    "Мини-челлендж: придумай 5 идей без оценки качества. Просто разгони мышление.",
    "Мини-челлендж: отправь кому-нибудь доброе сообщение.",
    "Мини-челлендж: 20 минут без отвлечений сделай самое важное дело.",
  ],
  truths: [
    "Что ты давно откладываешь, хотя знаешь, что это важно?",
    "Какая привычка быстрее всего улучшила бы твою жизнь?",
    "Чего ты боишься, но все равно хочешь попробовать?",
    "Какой совет ты дал бы себе год назад?",
    "Что сейчас нужнее: дисциплина, отдых, деньги или ясность?",
  ],
  riddles: [
    { q: "Загадка: без крыльев летит, без ног бежит. Что это?", a: "время" },
    { q: "Загадка: чем больше из нее берешь, тем больше она становится. Что это?", a: "яма" },
    { q: "Загадка: есть у дома, у двери, у книги, но не у человека. Что это?", a: "страница" },
  ],
  quiz: [
    {
      q: "Quiz: где безопаснее хранить Telegram token?",
      options: ["1) В .env", "2) Прямо в коде", "3) В сообщении другу"],
      answer: "1",
    },
    {
      q: "Quiz: что делает /guess?",
      options: ["1) Запускает AI", "2) Играет в угадай число", "3) Показывает ID"],
      answer: "2",
    },
    {
      q: "Quiz: зачем нужен Google Sheets?",
      options: ["1) Для логов сообщений", "2) Для кубика", "3) Для удаления бота"],
      answer: "1",
    },
  ],
};

function loadData() {
  if (!existsSync(dataPath)) {
    return { totalMessages: 0, users: {}, lastMessages: [] };
  }

  try {
    return JSON.parse(readFileSync(dataPath, "utf8"));
  } catch {
    return { totalMessages: 0, users: {}, lastMessages: [] };
  }
}

function saveData(data) {
  writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
}

const data = loadData();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function cleanText(text) {
  return String(text || "")
    .replaceAll("**", "")
    .replaceAll("*", "")
    .replaceAll("#", "")
    .replaceAll("_", "")
    .replace(/[<>`]/g, "")
    .trim();
}

function userLabel(message) {
  const from = message.from || {};
  return from.username ? `@${from.username}` : from.first_name || String(from.id || "unknown");
}

function isAdmin(message) {
  return config.adminIds.includes(message.from?.id);
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function loadGoogleCredentials() {
  const credentialsPath = join(process.cwd(), config.googleCredentialsPath);
  if (!existsSync(credentialsPath)) {
    return null;
  }

  return JSON.parse(readFileSync(credentialsPath, "utf8"));
}

async function getGoogleAccessToken() {
  if (state.accessToken && Date.now() < state.accessTokenExpiresAt - 60_000) {
    return state.accessToken;
  }

  const credentials = loadGoogleCredentials();
  if (!credentials) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const privateKey = credentials.private_key.replaceAll("\\n", "\n");
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  const assertion = `${unsigned}.${signature}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error_description || body.error || "Google auth failed");
  }

  state.accessToken = body.access_token;
  state.accessTokenExpiresAt = Date.now() + Number(body.expires_in || 3600) * 1000;
  return state.accessToken;
}

async function appendToSheet(message, answer) {
  if (!config.sheetId) {
    return false;
  }

  const token = await getGoogleAccessToken();
  if (!token) {
    return false;
  }

  const from = message.from || {};
  const values = [
    [
      new Date().toLocaleString("ru-RU"),
      from.id || "",
      from.username || "",
      from.first_name || "",
      message.text || "",
      answer || "",
    ],
  ];

  const range = encodeURIComponent(`${config.sheetName}!A:F`);
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}/values/${range}:append` +
    "?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ values }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message || "Google Sheets append failed");
  }

  return true;
}

async function trackMessage(message, answer = "") {
  const from = message.from || {};
  data.totalMessages += 1;
  data.users[from.id] = {
    id: from.id,
    username: from.username || "",
    firstName: from.first_name || "",
    lastSeen: new Date().toISOString(),
  };
  data.lastMessages.unshift({
    date: new Date().toLocaleString("ru-RU"),
    userId: from.id,
    username: from.username || "",
    firstName: from.first_name || "",
    text: message.text || "",
    answer,
  });
  data.lastMessages = data.lastMessages.slice(0, 10);
  saveData(data);

  try {
    await appendToSheet(message, answer);
  } catch (error) {
    console.error(`Google Sheets error: ${error.message}`);
  }
}

async function telegram(method, payload = {}) {
  if (!config.token) {
    throw new Error("TELEGRAM_BOT_TOKEN не найден в .env.");
  }

  const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json();
  if (!body.ok) {
    throw new Error(body.description || `${method} failed`);
  }

  return body.result;
}

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: cleanText(text).slice(0, 3900) || "Пустой ответ.",
  });
}

async function sendTyping(chatId) {
  return telegram("sendChatAction", { chat_id: chatId, action: "typing" });
}

async function askGemini(prompt) {
  if (!config.geminiApiKey) {
    return "Gemini API key не подключен. Добавь GEMINI_API_KEY в .env.";
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiApiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: [
                "Ты умный, живой и полезный Telegram-бот.",
                "Отвечай на русском языке.",
                "Будь коротким, интересным, практичным и дружелюбным.",
                "Сразу отвечай по делу.",
              ].join(" "),
            },
          ],
        },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.75, maxOutputTokens: 650 },
      }),
    },
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message || `Gemini error: ${response.status}`);
  }

  return cleanText(body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join(""));
}

async function startGuess(message) {
  const chatId = message.chat.id;
  const target = Math.floor(Math.random() * 1000) + 1;
  state.guessGames.set(chatId, { target, attempts: 0 });
  const answer = "Я загадал число от 1 до 1000. Напиши число, попробуй угадать.";
  await sendMessage(chatId, answer);
  await trackMessage(message, answer);
}

async function handleGuess(chatId, text) {
  const game = state.guessGames.get(chatId);
  if (!game || !/^\d+$/.test(text)) return null;

  const guess = Number.parseInt(text, 10);
  game.attempts += 1;

  if (guess === game.target) {
    state.guessGames.delete(chatId);
    return `Верно! Ты угадал за ${game.attempts} попыток.`;
  }

  return guess < game.target ? "Выше." : "Ниже.";
}

async function startQuiz(message) {
  const chatId = message.chat.id;
  const quiz = randomItem(games.quiz);
  state.quizGames.set(chatId, quiz);
  const answer = [quiz.q, ...quiz.options, "", "Ответь цифрой: 1, 2 или 3."].join("\n");
  await sendMessage(chatId, answer);
  await trackMessage(message, answer);
}

async function handleQuiz(chatId, text) {
  const quiz = state.quizGames.get(chatId);
  if (!quiz || !["1", "2", "3"].includes(text)) return null;

  state.quizGames.delete(chatId);
  return text === quiz.answer ? "Правильно." : `Неверно. Правильный ответ: ${quiz.answer}`;
}

async function replyAndTrack(message, answer) {
  await sendMessage(message.chat.id, answer);
  await trackMessage(message, answer);
}

async function handleCommand(message) {
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  const guessAnswer = await handleGuess(chatId, text);
  if (guessAnswer) {
    await replyAndTrack(message, guessAnswer);
    return;
  }

  const quizAnswer = await handleQuiz(chatId, text);
  if (quizAnswer) {
    await replyAndTrack(message, quizAnswer);
    return;
  }

  if (text === "/start") {
    return replyAndTrack(
      message,
      [
        "Привет. Я терминальный AI-бот с играми и логами.",
        "",
        "Главное:",
        "/ai вопрос",
        "/magic тема",
        "/games",
        "/id",
        "",
        "Админ:",
        "/admin",
      ].join("\n"),
    );
  }

  if (text === "/games") {
    return replyAndTrack(
      message,
      [
        "Игровой раздел:",
        "/guess - угадай число",
        "/quiz - мини-викторина",
        "/dice - кубик",
        "/riddle - загадка",
        "/challenge - челлендж дня",
        "/truth - вопрос на подумать",
        "/mood - режим дня",
      ].join("\n"),
    );
  }

  if (text === "/guess") return startGuess(message);
  if (text === "/quiz") return startQuiz(message);
  if (text === "/dice") return replyAndTrack(message, `🎲 Кубик: ${Math.floor(Math.random() * 6) + 1}`);
  if (text === "/challenge") return replyAndTrack(message, randomItem(games.challenges));
  if (text === "/truth") return replyAndTrack(message, randomItem(games.truths));
  if (text === "/mood") {
    const mood = randomItem(["Фокус", "Драйв", "Спокойствие", "Креатив", "Дисциплина", "Победа"]);
    return replyAndTrack(message, `Твой режим на сегодня: ${mood}. Сделай один маленький шаг в этом стиле.`);
  }
  if (text === "/riddle") {
    const riddle = randomItem(games.riddles);
    return replyAndTrack(message, `${riddle.q}\n\nЕсли хочешь подсказку, спроси: /ai дай подсказку к загадке`);
  }
  if (text === "/id") return replyAndTrack(message, `Твой Telegram ID: ${message.from?.id}`);

  if (text === "/admin") {
    if (!isAdmin(message)) {
      return replyAndTrack(message, "У тебя нет доступа к админ-панели.");
    }
    return replyAndTrack(
      message,
      "Админ-панель\n/stats - статистика\n/last - последние сообщения\n/id - узнать ID",
    );
  }

  if (text === "/stats") {
    if (!isAdmin(message)) return;
    const hasCredentials = existsSync(join(process.cwd(), config.googleCredentialsPath));
    const sheetStatus = config.sheetId && hasCredentials ? "подключен" : "не подключен";
    return replyAndTrack(
      message,
      `Всего сообщений: ${data.totalMessages}\nПользователей: ${Object.keys(data.users).length}\nGoogle Sheets: ${sheetStatus}`,
    );
  }

  if (text === "/last") {
    if (!isAdmin(message)) return;
    const rows = data.lastMessages
      .slice(0, 5)
      .map((row) => `${row.date}\n${row.username || row.firstName || row.userId}: ${row.text}`)
      .join("\n\n");
    return replyAndTrack(message, rows || "Сообщений пока нет.");
  }

  if (text.startsWith("/ai ")) {
    await sendTyping(chatId);
    const answer = await askGemini(text.slice(4).trim());
    return replyAndTrack(message, answer);
  }

  if (text.startsWith("/magic ")) {
    await sendTyping(chatId);
    const answer = await askGemini(
      `Сделай необычный интерактивный формат по теме: ${text.slice(7).trim()}. Дай 3 идеи, 1 мини-игру и 1 готовый пост для Telegram.`,
    );
    return replyAndTrack(message, answer);
  }

  await sendTyping(chatId);
  const answer = await askGemini(text);
  return replyAndTrack(message, answer);
}

async function poll() {
  const updates = await telegram("getUpdates", {
    offset: state.offset,
    timeout: 25,
    allowed_updates: ["message"],
  });

  for (const update of updates) {
    state.offset = update.update_id + 1;
    if (!update.message?.text) continue;

    try {
      console.log(`[${new Date().toLocaleTimeString("ru-RU")}] ${userLabel(update.message)}: ${update.message.text}`);
      await handleCommand(update.message);
    } catch (error) {
      console.error(`Message error: ${error.message}`);
      await sendMessage(update.message.chat.id, "Произошла техническая ошибка. Проверь терминал.");
    }
  }
}

async function main() {
  console.log("=== TERMINAL TELEGRAM BOT STARTING ===");
  await telegram("deleteWebhook", { drop_pending_updates: true });
  const me = await telegram("getMe");
  console.log(`Bot started: @${me.username}`);
  console.log(`Gemini: ${config.geminiApiKey ? "enabled" : "GEMINI_API_KEY missing"}`);
  console.log(`Google Sheets: ${config.sheetId ? "enabled by SHEET_ID" : "SHEET_ID missing"}`);
  console.log("Stop: Ctrl + C");

  while (true) {
    try {
      await poll();
    } catch (error) {
      console.error(`Polling error: ${error.message}`);
      await sleep(3000);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
