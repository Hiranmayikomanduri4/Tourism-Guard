import http from "http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { connectDatabase } from "./config/db.js";
import { createSocketServer } from "./sockets/index.js";

await connectDatabase();
const app = createApp();
const server = http.createServer(app);
const io = createSocketServer(server);
app.set("io", io);

server.listen(env.PORT, () => 
  console.log(`Tourism Guardian server running on http://localhost:${env.PORT}`)
);