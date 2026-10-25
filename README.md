# Telegram Menu Admin Bot

Telegram bot with the same compact inline menu as the reference, temporary “in development” replies, and an admin panel inside Telegram.

## What the admin panel can do

- Edit each button title and response text.
- Add, replace, or remove a photo for any button. Telegram keeps the image securely as a `file_id`, so no local files are stored.
- Send any section as a deliberate broadcast to everyone who has started the bot.
- Cancel an in-progress edit with `/cancel`.

## Commands

- `/start` — opens the public menu.
- `/admin123123321` — asks for the admin password and opens the management panel.

## Required Vercel environment variables

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather. Keep secret. |
| `TELEGRAM_WEBHOOK_SECRET` | Random secret used to verify Telegram webhook requests. |
| `ADMIN_PASSWORD` | Password prompted after the admin command. |
| `BLOB_READ_WRITE_TOKEN` | Added automatically when the private Vercel Blob store is connected. |

## Deploy and activate

1. Connect this repository to the Vercel project.
2. Add the first three variables above for Production, Preview, and Development.
3. Deploy the project.
4. Register `https://YOUR-DOMAIN/api/telegram` as the Telegram webhook, passing the same `TELEGRAM_WEBHOOK_SECRET` as Telegram’s `secret_token`.

The Vercel deployment must accept public requests on `/api/telegram`; otherwise Telegram cannot reach the webhook.

