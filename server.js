const express = require("express");
const { firefox } = require("playwright");
const WebSocket = require("ws");
const http = require("http");
const path = require("path");
const fs = require("fs");
const url = require("url");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const sessions = {};
const clientsInRoom = {};
const screenshotInterval = 50; // ms
const downloadDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

app.use(express.static("public"));

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8);
}

setInterval(() => {
  const now = Date.now();
  for (const room in sessions) {
    const session = sessions[room];
    const clients = clientsInRoom[room] || [];
    if (clients.length === 0 && now - session.lastActive > 180000) {
      console.log(`Cleaning up inactive room: ${room}`);
      try { session.browser.close(); } catch (e) {}
      delete sessions[room];
      delete clientsInRoom[room];
    }
  }
}, 60000);

wss.on("connection", async (ws, req) => {
  const query = url.parse(req.url, true).query;
  let room = query.room || generateRoomCode();

  if (!sessions[room]) {
    console.log(`Launching new Firefox session for room: ${room}`);
    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    await page.goto("https://www.google.com", { waitUntil: "domcontentloaded" });

    sessions[room] = { browser, context, page, lastActive: Date.now() };
    clientsInRoom[room] = [];

    context.on("download", async (download) => {
      const filePath = path.join(downloadDir, await download.suggestedFilename());
      await download.saveAs(filePath);
      const buffer = fs.readFileSync(filePath);
      const base64 = buffer.toString("base64");

      for (const client of clientsInRoom[room]) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: "file", filename: path.basename(filePath), data: base64 }));
        }
      }

      setTimeout(() => fs.unlink(filePath, () => {}), 2000);
    });
  }

  const session = sessions[room];
  const { page } = session;
  session.lastActive = Date.now();
  clientsInRoom[room].push(ws);

  console.log(`Client joined room: ${room}`);
  ws.send(JSON.stringify({ type: "status", text: "Connected to room." }));

  let firstShot = false;
  const shotLoop = setInterval(async () => {
    try {
      const shot = await page.screenshot({ type: "jpeg", quality: 70, timeout: 0 });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "screenshot", data: shot.toString("base64") }));
        if (!firstShot) {
          firstShot = true;
          ws.send(JSON.stringify({ type: "ready" }));
        }
      }
    } catch (err) {
      console.error("Screenshot failed:", err);
    }
  }, screenshotInterval);

  // Handle inputs
  ws.on("message", async (data) => {
    session.lastActive = Date.now();
    try {
      const msg = JSON.parse(data);

      if (msg.type === "mouse") {
        if (msg.action === "down") {
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.down({ button: msg.button });
        } else if (msg.action === "up") {
          await page.mouse.move(msg.x, msg.y);
          await page.mouse.up({ button: msg.button });
        } else {
          await page.mouse.move(msg.x, msg.y);
        }
      } else if (msg.type === "keyboard") {
        if (msg.action === "down") {
          await page.keyboard.down(msg.key);
        } else if (msg.action === "up") {
          await page.keyboard.up(msg.key);
        }
      } else if (msg.type === "scroll") {
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
      }
    } catch (err) {
      console.error("Input error:", err);
    }
  });

  // Handle disconnect
  ws.on("close", () => {
    console.log(`Client left room: ${room}`);
    clearInterval(shotLoop);
    const clients = clientsInRoom[room] || [];
    clientsInRoom[room] = clients.filter(c => c !== ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
