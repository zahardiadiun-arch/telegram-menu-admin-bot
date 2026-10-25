import { get, put } from "@vercel/blob";
import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_PATH = "telegram-menu-admin-bot/state.json";
const PLACEHOLDER = "...";
const LEGACY_PLACEHOLDER = "🚧 Цей розділ зараз у розробці.";

const initialButtons = [
  { id: "price", label: "📄 Прайс цін 📄" },
  { id: "order", label: "🚚 Замовити 🚚" },
  { id: "taxi", label: "🚚 Таксі і клади 📦" },
  { id: "reviews", label: "✍️ Відгуки ✍️" },
  { id: "uah", label: "💵 Фото Гривни 🇺🇦" },
  { id: "usd", label: "💵 Фото Долари 🇺🇸" },
  { id: "eur", label: "💶 Фото Євро 🇪🇺" },
  { id: "cards", label: "💳 Картки банків 💳" },
  { id: "guide", label: "📑 Інструкція 📑" },
  { id: "why", label: "❓ Чому продаємо ❓" },
];

function emptyState() {
  return {
    buttons: initialButtons.map((button) => ({ ...button, text: PLACEHOLDER, photoFileId: null })),
    users: {},
    sessions: {},
  };
}

function normalizeState(value) {
  const fallback = emptyState();
  if (!value || typeof value !== "object") return fallback;

  const savedButtons = Array.isArray(value.buttons) ? value.buttons : [];
  fallback.buttons = fallback.buttons.map((fallbackButton) => {
    const saved = savedButtons.find((button) => button?.id === fallbackButton.id);
    const normalizedSaved = saved && typeof saved === "object" ? { ...saved } : {};
    if (normalizedSaved.text === LEGACY_PLACEHOLDER) normalizedSaved.text = PLACEHOLDER;
    return {
      ...fallbackButton,
      ...normalizedSaved,
      id: fallbackButton.id,
    };
  });
  fallback.users = value.users && typeof value.users === "object" ? value.users : {};
  const savedSessions = value.sessions && typeof value.sessions === "object" ? value.sessions : {};
  fallback.sessions = Object.fromEntries(
    Object.entries(savedSessions).map(([chatId, session]) => {
      const stage = session?.stage;
      const validStage = stage
        && typeof stage === "object"
        && ["text", "title", "photo"].includes(stage.kind)
        && typeof stage.id === "string";
      return [chatId, validStage ? { stage } : {}];
    }),
  );
  return fallback;
}

async function readState() {
  try {
    const result = await get(STATE_PATH, { access: "private" });
    if (!result || result.statusCode !== 200) return emptyState();
    return normalizeState(await new Response(result.stream).json());
  } catch (error) {
    console.error("Unable to read bot state", error);
    return emptyState();
  }
}

async function writeState(state) {
  await put(STATE_PATH, JSON.stringify(state), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function token() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return process.env.TELEGRAM_BOT_TOKEN;
}

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed: ${data?.description || response.status}`);
  }
  return data.result;
}

function menuKeyboard(state) {
  const byId = Object.fromEntries(state.buttons.map((button) => [button.id, button]));
  const row = (...ids) => ids.map((id) => byId[id].label);
  return {
    keyboard: [
      row("price", "order"),
      row("taxi", "reviews"),
      row("uah", "usd", "eur"),
      row("cards", "guide", "why"),
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Оберіть розділ",
  };
}

function makeAdminToken(chatId) {
  return createHmac("sha256", process.env.ADMIN_PASSWORD || "missing-password")
    .update(String(chatId))
    .digest("hex")
    .slice(0, 16);
}

function hasValidAdminToken(chatId, candidate) {
  if (!candidate || candidate.length !== 16) return false;
  const expected = makeAdminToken(chatId);
  return timingSafeEqual(Buffer.from(expected), Buffer.from(candidate));
}

function adminKeyboard(chatId) {
  const token = makeAdminToken(chatId);
  return {
    inline_keyboard: [
      [{ text: "🛠 Редагувати кнопки", callback_data: `ad:${token}:buttons` }],
      [{ text: "📣 Розсилка розділу", callback_data: `ad:${token}:broadcast` }],
      [{ text: "⌨️ Звичайне меню", callback_data: `ad:${token}:public` }],
    ],
  };
}

function buttonPicker(state, chatId, action, title = "Оберіть кнопку") {
  const token = makeAdminToken(chatId);
  return {
    text: title,
    reply_markup: {
      inline_keyboard: [
        ...state.buttons.map((button) => [{ text: button.label, callback_data: `ad:${token}:${action}:${button.id}` }]),
        [{ text: "‹ До адмін-панелі", callback_data: `ad:${token}:admin` }],
      ],
    },
  };
}

function editKeyboard(button, chatId) {
  const token = makeAdminToken(chatId);
  return {
    inline_keyboard: [
      [{ text: "✍️ Змінити текст", callback_data: `ad:${token}:text:${button.id}` }],
      [{ text: "🖼 Додати / замінити фото", callback_data: `ad:${token}:photo:${button.id}` }],
      ...(button.photoFileId ? [[{ text: "🗑 Видалити фото", callback_data: `ad:${token}:clearphoto:${button.id}` }]] : []),
      [{ text: "✏️ Змінити назву", callback_data: `ad:${token}:title:${button.id}` }],
      [{ text: "‹ До кнопок", callback_data: `ad:${token}:buttons` }],
    ],
  };
}

function findButton(state, id) {
  return state.buttons.find((button) => button.id === id);
}

function findButtonByLabel(state, label) {
  return state.buttons.find((button) => button.label === label);
}

async function showPublicMenu(state, chatId) {
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "...",
    reply_markup: menuKeyboard(state),
  });
}

function rememberUser(state, chat, user) {
  if (!chat?.id) return false;
  const key = String(chat.id);
  const old = state.users[key];
  state.users[key] = {
    chatId: chat.id,
    firstName: user?.first_name || old?.firstName || "",
    username: user?.username || old?.username || "",
    startedAt: old?.startedAt || new Date().toISOString(),
  };
  return !old || old.firstName !== state.users[key].firstName || old.username !== state.users[key].username;
}

async function sendSection(chatId, button, replyMarkup) {
  const text = button.text?.trim() || PLACEHOLDER;
  if (button.photoFileId) {
    await telegram("sendPhoto", {
      chat_id: chatId,
      photo: button.photoFileId,
      ...(text.length <= 1024 ? { caption: text, reply_markup: replyMarkup } : { reply_markup: replyMarkup }),
    });
    if (text.length > 1024) return telegram("sendMessage", { chat_id: chatId, text });
    return;
  }
  return telegram("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup });
}

async function showAdmin(chatId, text = "Адмін-панель") {
  await telegram("sendMessage", { chat_id: chatId, text, reply_markup: adminKeyboard(chatId) });
}

async function showEdit(chatId, button, savedMessage = "") {
  const photoStatus = button.photoFileId ? "✅ фото встановлено" : "— фото немає";
  const contentPreview = button.text?.trim()
    ? `Текст зараз: ${button.text.trim().slice(0, 350)}`
    : "Текст зараз: ...";
  const confirmation = savedMessage ? `✅ ${savedMessage}\n\n` : "";
  await telegram("sendMessage", {
    chat_id: chatId,
    text: `${confirmation}Кнопка: ${button.label}\n${photoStatus}\n${contentPreview}\n\nОберіть, що редагувати:`,
    reply_markup: editKeyboard(button, chatId),
  });
}

async function handleAdminText(message, state) {
  const chatId = message.chat.id;
  const key = String(chatId);
  const session = state.sessions[key] || {};
  const text = message.text?.trim();

  if (text === "/cancel") {
    delete session.stage;
    state.sessions[key] = session;
    await showAdmin(chatId, "Поточну дію скасовано.");
    return true;
  }

  // A valid password always opens a fresh admin panel. There is no sticky
  // "waiting for password" state that can accidentally block the public menu.
  if (text && text === process.env.ADMIN_PASSWORD) {
    state.sessions[key] = {};
    await showAdmin(chatId, "✅ Доступ дозволено. Що змінюємо?");
    return true;
  }

  if (!session.stage) return false;
  const { kind, id } = session.stage;
  const button = findButton(state, id);
  if (!button) {
    delete session.stage;
    state.sessions[key] = session;
    await showAdmin(chatId, "Кнопку не знайдено. Оберіть її ще раз.");
    return true;
  }

  if (kind === "text") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть текстовий опис або /cancel." });
      return true;
    }
    button.text = text;
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button, "Текст збережено.");
    return true;
  }

  if (kind === "title") {
    if (!text) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть нову назву кнопки або /cancel." });
      return true;
    }
    button.label = text.slice(0, 60);
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button, "Назву кнопки збережено.");
    return true;
  }

  if (kind === "photo") {
    const photo = message.photo?.at(-1);
    if (!photo) {
      await telegram("sendMessage", { chat_id: chatId, text: "Надішліть саме фото як зображення (не файлом) або /cancel." });
      return true;
    }
    button.photoFileId = photo.file_id;
    delete session.stage;
    state.sessions[key] = session;
    await showEdit(chatId, button, "Фото збережено.");
    return true;
  }

  return false;
}

async function handleCallback(query, state) {
  const data = query.data || "";
  const chatId = query.message?.chat?.id;
  const sessionKey = String(chatId);
  await telegram("answerCallbackQuery", { callback_query_id: query.id });

  if (data.startsWith("open:")) {
    const button = findButton(state, data.slice(5));
    if (button) await sendSection(chatId, button, menuKeyboard(state));
    return;
  }

  const [, receivedToken, action, id] = data.split(":");
  if (!hasValidAdminToken(chatId, receivedToken)) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "Ця стара адмін-панель більше не активна. Надішліть /admin123123321 і пароль ще раз.",
    });
    return;
  }

  if (action === "public") {
    await showPublicMenu(state, chatId);
    return;
  }
  if (action === "admin") {
    await showAdmin(chatId);
    return;
  }
  if (action === "buttons") {
    const picker = buttonPicker(state, chatId, "edit", "Оберіть кнопку для редагування:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }

  const button = id ? findButton(state, id) : null;
  if (["edit", "text", "title", "photo", "clearphoto", "send", "confirm"].includes(action) && !button) return;

  if (action === "edit") {
    await showEdit(chatId, button);
    return;
  }
  if (["text", "title", "photo"].includes(action)) {
    const prompts = {
      text: `Надішліть новий текст для «${button.label}».`,
      title: `Надішліть нову назву для «${button.label}».`,
      photo: `Надішліть фото для «${button.label}» як зображення.`,
    };
    state.sessions[sessionKey] = {
      stage: { kind: action, id },
    };
    // Save the chosen edit action before displaying its prompt. This prevents
    // a fast reply from being handled before the stage reaches storage.
    await writeState(state);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `${prompts[action]}\n\nПросто надішліть текст або фото в чат. Для скасування: /cancel`,
    });
    return;
  }
  if (action === "clearphoto") {
    button.photoFileId = null;
    await showEdit(chatId, button);
    return;
  }
  if (action === "broadcast") {
    const picker = buttonPicker(state, chatId, "send", "Оберіть розділ для розсилки всім користувачам:");
    await telegram("sendMessage", { chat_id: chatId, ...picker });
    return;
  }
  if (action === "send") {
    const token = makeAdminToken(chatId);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `Розіслати «${button.label}» усім, хто запускав бота?`,
      reply_markup: {
        inline_keyboard: [
          [{ text: "✅ Так, розіслати", callback_data: `ad:${token}:confirm:${button.id}` }],
          [{ text: "‹ До адмін-панелі", callback_data: `ad:${token}:admin` }],
        ],
      },
    });
    return;
  }
  if (action === "confirm") {
    let delivered = 0;
    let failed = 0;
    for (const user of Object.values(state.users)) {
      try {
        await sendSection(user.chatId, button);
        delivered += 1;
      } catch (error) {
        failed += 1;
        console.error("Broadcast delivery failed", error);
      }
    }
    await showAdmin(chatId, `Розсилку завершено. Надіслано: ${delivered}. Не доставлено: ${failed}.`);
  }
}

export async function POST(request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expectedSecret || receivedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const update = await request.json();
    const state = await readState();
    let changed = false;

    if (update.message) {
      const { message } = update;
      changed ||= rememberUser(state, message.chat, message.from);
      const chatId = message.chat.id;
      const command = message.text?.trim();

      if (command === "/start") {
        state.sessions[String(chatId)] = {};
        await showPublicMenu(state, chatId);
        changed = true;
      } else if (command === "/admin123123321") {
        state.sessions[String(chatId)] = {};
        changed = true;
        await telegram("sendMessage", { chat_id: chatId, text: "Введіть пароль для адмін-панелі:" });
      } else {
        // Public-menu buttons always win over any unfinished edit action.
        // A user can therefore leave editing by simply choosing a section.
        const selectedButton = findButtonByLabel(state, command);
        if (selectedButton) {
          await sendSection(chatId, selectedButton, menuKeyboard(state));
        }
        const handled = selectedButton ? false : await handleAdminText(message, state);
        if (handled) changed = true;
      }
    }

    if (update.callback_query) {
      const query = update.callback_query;
      changed ||= rememberUser(state, query.message?.chat, query.from);
      await handleCallback(query, state);
      if (query.data?.startsWith("ad:")) changed = true;
    }

    if (changed) await writeState(state);
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Telegram webhook failed", error);
    return Response.json({ ok: true });
  }
}

