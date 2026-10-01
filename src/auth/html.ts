/** Minimal HTML helpers for the two browser-facing pages in the OAuth flow. */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 2rem 1rem;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #f6f7f9; color: #14181f;
  }
  main {
    width: 100%; max-width: 30rem; background: #fff; border: 1px solid #e3e6ea;
    border-radius: 14px; padding: 2rem; box-shadow: 0 1px 3px rgb(0 0 0 / 0.06);
  }
  h1 { margin: 0 0 .25rem; font-size: 1.2rem; letter-spacing: -0.01em; }
  p { margin: .6rem 0; }
  .muted { color: #5b6472; font-size: .9rem; }
  dl { margin: 1.25rem 0; display: grid; grid-template-columns: auto 1fr; gap: .4rem 1rem; font-size: .9rem; }
  dt { color: #5b6472; }
  dd { margin: 0; font-weight: 500; overflow-wrap: anywhere; }
  ul { margin: .6rem 0; padding-left: 1.2rem; font-size: .9rem; }
  .actions { display: flex; gap: .6rem; margin-top: 1.5rem; }
  button {
    flex: 1; padding: .7rem 1rem; border-radius: 9px; font: inherit; font-weight: 550;
    cursor: pointer; border: 1px solid transparent;
  }
  button.primary { background: #14181f; color: #fff; }
  button.secondary { background: #fff; color: #14181f; border-color: #cfd4da; }
  .warn {
    margin-top: 1rem; padding: .7rem .85rem; border-radius: 9px; font-size: .85rem;
    background: #fff6e5; border: 1px solid #f0dcae; color: #6a4a05;
  }
  code { font-size: .85em; background: #f0f1f4; padding: .1em .35em; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #14181f; color: #e9ecf1; }
    main { background: #1c222c; border-color: #2c333f; }
    .muted, dt { color: #98a2b3; }
    button.primary { background: #e9ecf1; color: #14181f; }
    button.secondary { background: transparent; color: #e9ecf1; border-color: #3b4453; }
    .warn { background: #322708; border-color: #5b4a10; color: #f0dcae; }
    code { background: #262d38; }
  }
`;

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export function errorPage(title: string, message: string, hint?: string): string {
  return htmlPage(
    title,
    `<h1>${escapeHtml(title)}</h1>
     <p>${escapeHtml(message)}</p>
     ${hint ? `<p class="muted">${escapeHtml(hint)}</p>` : ""}`,
  );
}
