// The Home page's counter. A file rather than an inline <script>: the server's
// CSP is script-src 'self' (server/app.js).
document.querySelector('[data-testid="counter-increment"]')?.addEventListener('click', () => {
  const el = document.querySelector('[data-testid="counter-value"]');
  if (el) el.textContent = String(Number(el.textContent) + 1);
});
