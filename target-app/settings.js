// The Settings page's Save confirmation. A file rather than an inline <script>:
// the server's CSP is script-src 'self' (server/app.js).
document.querySelector('[data-testid="save-button"]')?.addEventListener('click', () => {
  document
    .querySelector('[data-testid="save-confirmation"]')
    ?.classList.add('save-confirmation--visible');
});
