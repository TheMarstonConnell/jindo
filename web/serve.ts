import index from "./index.html";

const port = Number(process.env.PORT ?? 4321);
const hostname = process.env.HOST ?? "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`jindo web demo on ${server.url}`);
