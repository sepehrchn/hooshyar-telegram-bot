import Groq from "groq-sdk";
import { knowledge } from "./knowledge";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GROQ_API_KEY: string;
}

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    text?: string;
  };
}

async function sendTelegramMessage(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
    }),
  });
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

    const message = update.message;
    if (!message?.text || !message.chat?.id) {
      return new Response("OK", { status: 200 });
    }

    const chatId = message.chat.id;
    const userText = message.text;

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

      const reply =
        completion.choices[0]?.message?.content?.trim() ||
        "متاسفم، در حال حاضر نمی‌توانم پاسخ دهم. لطفاً از فرم تماس در سایت استفاده کنید.";

      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    } catch (err) {
      console.error("Bot error:", err);
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        "متاسفم، مشکلی پیش آمد. لطفاً بعداً دوباره امتحان کنید یا از فرم تماس در سایت استفاده کنید."
      );
    }

    return new Response("OK", { status: 200 });
  },
};