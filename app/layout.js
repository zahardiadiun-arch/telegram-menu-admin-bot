export const metadata = {
  title: "Telegram Menu Bot",
  description: "Telegram bot with an editable menu",
};

export default function RootLayout({ children }) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}

