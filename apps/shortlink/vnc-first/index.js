const TARGET = "https://172.19.20.9:8446/vnc.html?autoconnect=1&resize=remote";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/vnc.html" || url.pathname === "/viewer") {
      return Response.redirect(TARGET, 302);
    }

    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  },
};
