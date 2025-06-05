const express = require("express");
const { firefox } = require("playwright");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");
const fs = require("fs");
const url = require("url");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const sessions = {};
const clientsInRoom = {};
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
      console.log(`Room ${room} inactive for 3 minutes. Cleaning up.`);
      try {
        session.browser.close();
      } catch (e) {}
      delete sessions[room];
      delete clientsInRoom[room];
    }
  }
}, 60000);

wss.on("connection", async (ws, req) => {
  const query = url.parse(req.url, true).query;
  let room = query.room;

  if (!room) {
    room = generateRoomCode();
    ws.send(JSON.stringify({ type: "room", room }));
    return;
  }

  if (!sessions[room]) {
    console.log("Launching Firefox for room:", room);
    const browser = await firefox.launch({ headless: true });
    const context = await browser.newContext({
      acceptDownloads: true,
    });
    const page = await context.newPage();
    await page.goto("https://www.google.com");
    sessions[room] = { browser, context, page, lastActive: Date.now() };
    clientsInRoom[room] = [];

    context.on("download", async (download) => {
      try {
        const filePath = path.join(downloadDir, await download.suggestedFilename());
        await download.saveAs(filePath);
        const buffer = fs.readFileSync(filePath);

        const clients = clientsInRoom[room] || [];
        for (const client of clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: "file",
              filename: path.basename(filePath),
              data: buffer.toString("base64")
            }));
          }
        }

        setTimeout(() => {
          fs.unlink(filePath, (err) => {
            if (err) console.error("Failed to delete download:", err);
            else console.log("Deleted downloaded file:", filePath);
          });
        }, 1000);
      } catch (err) {
        console.error("Download handling failed:", err);
      }
    });
  }

  const { page } = sessions[room];
  clientsInRoom[room].push(ws);
  sessions[room].lastActive = Date.now();
  console.log(`Client connected to room ${room}`);

  ws.send(JSON.stringify({ type: "status", text: "Joining and authorizing you (may take a while)" }));

  let firstScreenshotSent = false;

  const interval = setInterval(async () => {
    try {
      const screenshot = await page.screenshot({ type: "jpeg", quality: 70, timeout: 0 });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "screenshot", data: screenshot.toString("base64") }));
        if (!firstScreenshotSent) {
          ws.send(JSON.stringify({ type: "ready" }));
          firstScreenshotSent = true;
        }
      }
    } catch (err) {
      console.error("Screenshot error:", err);
    }
  }, 20);

  ws.on("message", async (message) => {
    sessions[room].lastActive = Date.now();
    const msg = JSON.parse(message);

    if (msg.type === "mouse") {
      try {
        await page.mouse.move(msg.x, msg.y);
        if (msg.action === "down") await page.mouse.down({ button: msg.button });
        else if (msg.action === "up") await page.mouse.up({ button: msg.button });
      } catch (e) {
        console.error("Mouse input error:", e);
      }
    } else if (msg.type === "keyboard") {
      try {
        if (msg.action === "down") await page.keyboard.down(msg.key);
        else if (msg.action === "up") await page.keyboard.up(msg.key);
      } catch (e) {
        console.error("Keyboard input error:", e);
      }
    } else if (msg.type === "scroll") {
      try {
        await page.mouse.wheel(msg.deltaX, msg.deltaY);
      } catch (e) {
        console.error("Scroll input error:", e);
      }
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected from room ${room}`);
    clearInterval(interval);
    const clients = clientsInRoom[room];
    if (clients) {
      clientsInRoom[room] = clients.filter((client) => client !== ws);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
