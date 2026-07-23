import './globals.css';

export const metadata = {
  title: 'Chat with a Website',
  description: 'Crawl a site and ask questions about it, with sources.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
