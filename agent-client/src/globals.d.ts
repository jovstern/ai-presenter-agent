// Window globals the agent-client really reads. sandbox/index.html sets the
// nonce in an inline script before agent-client.js runs (server/index.js
// templates it in; docs/code-review-notes.md H1).
interface Window {
  __DS_NONCE__?: string;
}
