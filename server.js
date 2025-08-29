const express = require("express");
const { firefox } = require("playwright");
const WebSocket = require("ws");
const path = require("path");
const http = require("http");
const url = require("url");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static("public"));

const sessions = {};
const clientsInRoom = {};
const lastActivity = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8);
}

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
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("https://www.google.com");
    sessions[room] = { browser, page };
    clientsInRoom[room] = new Set();
  }

  clientsInRoom[room].add(ws);
  lastActivity[room] = Date.now();

  const { page } = sessions[room];
  console.log(`Client connected to room ${room}`);
  ws.send(JSON.stringify({ type: "status", text: "Joining and authorizing..." }));

  let firstScreenshotSent = false;

  const interval = setInterval(async () => {
    try {
      const screenshot = await page.screenshot({ type: "jpeg", quality: 70 });
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
  }, 1000 / 15); 

  ws.on("message", async (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    lastActivity[room] = Date.now();

    if (msg.type === "mouse") {
      try {
        if (msg.action === "move") {
          await page.mouse.move(msg.x, msg.y);
        } else if (msg.action === "down") {
          await page.mouse.move(msg.x, msg.y); 
          await page.mouse.down({ button: msg.button });
        } else if (msg.action === "up") {
          await page.mouse.move(msg.x, msg.y); 
          await page.mouse.up({ button: msg.button });
        }
      } catch (err) {
        console.warn("Mouse event error:", err);
      }
    } else if (msg.type === "keyboard") {
      try {
        if (msg.action === "down") {
          await page.keyboard.down(msg.key);
        } else if (msg.action === "up") {
          await page.keyboard.up(msg.key);
        }
      } catch (err) {
        console.warn("Keyboard event error:", err);
      }
    } else if (msg.type === "cursor") {
      for (const client of clientsInRoom[room]) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "cursor",
            id: msg.id,
            x: msg.x,
            y: msg.y
          }));
        }
      }
    }
  });

  ws.on("close", async () => {
    console.log(`Client disconnected from room ${room}`);
    clientsInRoom[room].delete(ws);
    clearInterval(interval);
  });
});

setInterval(async () => {
  const now = Date.now();
  for (const room in sessions) {
    const inactive = now - (lastActivity[room] || 0) > 180000; 
    const isEmpty = !clientsInRoom[room] || clientsInRoom[room].size === 0;

    if (inactive && isEmpty) {
      console.log(`Room ${room} inactive for 3 mins. Cleaning up.`);
      try {
        await sessions[room].browser.close();
      } catch {}
      delete sessions[room];
      delete clientsInRoom[room];
      delete lastActivity[room];
    }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
