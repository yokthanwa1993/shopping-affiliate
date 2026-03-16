const TARGETS = {
  chearb: "https://chearbshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote",
  neezs: "https://neezsshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote",
  golf: "https://golfshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote",
  first: "https://firstshortlink.pubilo.com/vnc.html?autoconnect=1&resize=remote",
}

function renderChooser(selected) {
  const buttons = Object.entries(TARGETS)
    .map(([key, href]) => {
      const active = selected === key ? " active" : ""
      return `<a class="button${active}" href="${href}">${key}</a>`
    })
    .join("")

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Shortlink Viewer</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b1020;
        --panel: rgba(15, 23, 42, 0.82);
        --line: rgba(148, 163, 184, 0.18);
        --text: #e2e8f0;
        --muted: #94a3b8;
        --accent: #38bdf8;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 42%),
          linear-gradient(180deg, #111827 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        width: min(520px, 100%);
        padding: 28px;
        border: 1px solid var(--line);
        border-radius: 24px;
        background: var(--panel);
        backdrop-filter: blur(16px);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 28px;
      }
      p {
        margin: 0 0 20px;
        color: var(--muted);
        line-height: 1.5;
      }
      .grid {
        display: grid;
        gap: 12px;
      }
      .button {
        display: block;
        padding: 14px 16px;
        border: 1px solid var(--line);
        border-radius: 16px;
        color: var(--text);
        text-decoration: none;
        background: rgba(15, 23, 42, 0.55);
        transition: border-color 0.15s ease, transform 0.15s ease;
      }
      .button:hover,
      .button.active {
        border-color: rgba(56, 189, 248, 0.65);
        transform: translateY(-1px);
      }
      code {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Shortlink Viewer</h1>
      <p>Open a viewer directly or use <code>?launch=chearb</code> / <code>?launch=neezs</code> / <code>?launch=golf</code> / <code>?launch=first</code>.</p>
      <div class="grid">${buttons}</div>
    </main>
  </body>
</html>`
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const launch = (url.searchParams.get("launch") || "").trim().toLowerCase()

    if (url.pathname === "/") {
      return Response.redirect(`${url.origin}/vnc.html${url.search}`, 302)
    }

    if (url.pathname === "/vnc.html" || url.pathname === "/viewer") {
      const target = TARGETS[launch]
      if (target) {
        return Response.redirect(target, 302)
      }

      return new Response(renderChooser(launch), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      })
    }

    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    })
  },
}
