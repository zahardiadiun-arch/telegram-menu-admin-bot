import { get, put } from "@vercel/blob";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_PATH = "telegram-menu-admin-bot/state.json";
const BROADCAST_PATH = "telegram-menu-admin-bot/broadcast.json";

function token() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return process.env.TELEGRAM_BOT_TOKEN;
}

async function readJson(path, fallback) {
  try {
    const result = await get(path, { access: "private" });
    return !result || result.statusCode !== 200 ? fallback : await new Response(result.stream).json();
  } catch (error) {
    console.error(`Unable to read ${path}`, error);
    return fallback;
  }
}

async function writeBroadcast(broadcast) {
  await put(BROADCAST_PATH, JSON.stringify(broadcast), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function kyivNow() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, hour: Number(values.hour) };
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) throw new Error(`Telegram ${method} failed: ${data?.description || response.status}`);
}

async function send(chatId, content) {
  const text = content.text?.trim() || "";
  if (content.photoFileId) {
    await telegram("sendPhoto", { chat_id: chatId, photo: content.photoFileId, ...(text && text.length <= 1024 ? { caption: text } : {}) });
    if (text.length > 1024) await telegram("sendMessage", { chat_id: chatId, text });
  } else if (text) {
    await telegram("sendMessage", { chat_id: chatId, text });
  }
}

export async function GET(request, { params }) {
  // Reading params ensures this handler is treated as a dynamic route for all 24 cron paths.
  await params;
  const authorization = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const broadcast = await readJson(BROADCAST_PATH, null);
    const schedule = broadcast?.schedule;
    const content = broadcast?.content;
    if (!schedule?.enabled || !content || (!content.text?.trim() && !content.photoFileId)) return Response.json({ skipped: true });

    const now = kyivNow();
    const runKey = schedule.mode === "hourly" ? `${now.date}-${now.hour}` : now.date;
    const due = schedule.mode === "hourly" || (schedule.mode === "daily" && schedule.hour === now.hour);
    if (!due || schedule.lastRunKey === runKey) return Response.json({ skipped: true });

    // Mark the slot first, so a platform retry cannot accidentally send the same broadcast twice.
    broadcast.schedule.lastRunKey = runKey;
    await writeBroadcast(broadcast);

    const state = await readJson(STATE_PATH, { users: {} });
    let delivered = 0;
    let failed = 0;
    for (const user of Object.values(state.users || {})) {
      try {
        await send(user.chatId, content);
        delivered += 1;
      } catch (error) {
        failed += 1;
        console.error("Scheduled broadcast delivery failed", error);
      }
    }
    return Response.json({ delivered, failed });
  } catch (error) {
    console.error("Scheduled broadcast failed", error);
    // A 200 response prevents a retry from duplicating a broadcast after a transient error.
    return Response.json({ ok: false });
  }
}

