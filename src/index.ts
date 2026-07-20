import Groq from "groq-sdk";
import { knowledge } from "./knowledge";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
  ADMIN_CHAT_ID: string;
  BOT_SESSIONS: KVNamespace;
}

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { first_name?: string; username?: string };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { first_name?: string; username?: string };
    message: { chat: { id: number } };
    data: string;
  };
}

interface SessionData {
  firstName?: string;
  username?: string;
  messages: string[];
  lastActive: number;
}

const WELCOME_TEXT = `سلام! 👋 به هوش‌یار خوش آمدید.
من دستیار هوشمند هوش‌یار هستم و می‌توانم درباره خدمات ما راهنمایی‌تان کنم.

یکی از گزینه‌های زیر را انتخاب کنید یا سوال خود را مستقیم بنویسید:`;

const WELCOME_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🤖 هوش مصنوعی", callback_data: "topic_ai" }],
    [{ text: "⚙️ اتوماسیون", callback_data: "topic_automation" }],
    [{ text: "🌐 طراحی سایت", callback_data: "topic_web" }],
    [{ text: "ℹ️ درباره هوش‌یار", callback_data: "topic_about" }],
  ],
};

const TOPIC_PROMPTS: Record<string, string> = {
  topic_ai: "درباره خدمات هوش مصنوعی هوش‌یار توضیح بده",
  topic_automation: "درباره خدمات اتوماسیون هوش‌یار توضیح بده",
  topic_web: "درباره خدمات طراحی سایت هوش‌یار توضیح بده",
  topic_about: "درباره هوش‌یار و اینکه چه کسی هستید توضیح بده",
};

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: object
) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
}

async function answerCallbackQuery(token: string, callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function getSession(kv: KVNamespace, chatId: number): Promise<SessionData> {
  const raw = await kv.get(`session:${chatId}`);
  if (raw) return JSON.parse(raw);
  return { messages: [], lastActive: Date.now() };
}

async function saveSession(kv: KVNamespace, chatId: number, session: SessionData) {
  await kv.put(`session:${chatId}`, JSON.stringify(session), {
    expirationTtl: 60 * 60 * 24, // auto-expire after 24h as a safety net
  });
}

async function notifyAdminContactRequest(
  env: Env,
  chatId: number,
  firstName: string | undefined,
  username: string | undefined,
  userMessage: string
) {
  const text = `📩 درخواست تماس جدید!

کاربر: ${firstName || "نامشخص"}
یوزرنیم: ${username ? `@${username}` : "ثبت نشده"}
Chat ID: ${chatId}
پیام: ${userMessage}`;
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, Number(env.ADMIN_CHAT_ID), text);
}

async function handleUserText(
  env: Env,
  chatId: number,
  userText: string,
  firstName?: string,
  username?: string
) {
  const session = await getSession(env.BOT_SESSIONS, chatId);
  session.firstName = firstName;
  session.username = username;
  session.lastActive = Date.now();

  try {
    const groq = new Groq({ apiKey: env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: knowledge },
        { role: "user", content: userText },
      ],
      temperature: 0.7,
      max_tokens: 500,
    });

    let reply =
      completion.choices[0]?.message?.content?.trim() ||
      "متاسفم، در حال حاضر نمی‌توانم پاسخ دهم. لطفاً از ایمیل استفاده کنید.";

    // Detect and strip the contact-request marker
    if (reply.includes("[CONTACT_REQUEST]")) {
      reply = reply.replace("[CONTACT_REQUEST]", "").trim();
      await notifyAdminContactRequest(env, chatId, firstName, username, userText);
    }

    session.messages.push(`کاربر: ${userText}`);
    session.messages.push(`بات: ${reply}`);
    await saveSession(env.BOT_SESSIONS, chatId, session);

    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
  } catch (err) {
    console.error("Bot error:", err);
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "متاسفم، مشکلی پیش آمد. لطفاً بعداً دوباره امتحان کنید یا از ایمیل استفاده کنید."
    );
  }
}

async function checkIdleSessionsAndReport(env: Env) {
  const list = await env.BOT_SESSIONS.list({ prefix: "session:" });
  const now = Date.now();
  const idleThresholdMs = 15 * 60 * 1000; // 15 minutes idle = session ended

  for (const key of list.keys) {
    const raw = await env.BOT_SESSIONS.get(key.name);
    if (!raw) continue;
    const session: SessionData = JSON.parse(raw);

    if (now - session.lastActive > idleThresholdMs && session.messages.length > 0) {
      const chatId = key.name.replace("session:", "");
      const summary = `📊 گزارش پایان گفتگو

کاربر: ${session.firstName || "نامشخص"}
یوزرنیم: ${session.username ? `@${session.username}` : "ثبت نشده"}
Chat ID: ${chatId}
تعداد پیام‌ها: ${session.messages.length}

موضوعات مطرح‌شده:
${session.messages.filter((m) => m.startsWith("کاربر:")).join("\n")}`;

      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        Number(env.ADMIN_CHAT_ID),
        summary
      );

      await env.BOT_SESSIONS.delete(key.name);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK — Telegram bot is running", { status: 200 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Handle button clicks
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const topicPrompt = TOPIC_PROMPTS[cq.data];

      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, cq.id);

      if (topicPrompt) {
        await handleUserText(
          env,
          chatId,
          topicPrompt,
          cq.from.first_name,
          cq.from.username
        );
      }
      return new Response("OK", { status: 200 });
    }

    // Handle normal messages
    const message = update.message;
    if (!message?.text || !message.chat?.id) {
      return new Response("OK", { status: 200 });
    }

    const chatId = message.chat.id;
    const userText = message.text;

    if (userText === "/start") {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        WELCOME_TEXT,
        WELCOME_KEYBOARD
      );
      return new Response("OK", { status: 200 });
    }

    await handleUserText(
      env,
      chatId,
      userText,
      message.from?.first_name,
      message.from?.username
    );

    return new Response("OK", { status: 200 });
  },

  // Cron Trigger — runs on schedule defined in wrangler.jsonc
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await checkIdleSessionsAndReport(env);
  },
};