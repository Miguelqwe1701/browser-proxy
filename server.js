const express = require("express")
const { firefox } = require("playwright")
const WebSocket = require("ws")
const http = require("http")
const url = require("url")

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.static("public"))

const sessions = {}
const clients = {}
const activity = {}

const rand = () => Math.random().toString(36).slice(2, 9)

wss.on("connection", async (ws, req) => {
  const query = url.parse(req.url, true).query
  let room = query.room || rand()

  if (!query.room) ws.send(JSON.stringify({ type: "room", room }))

  if (!sessions[room]) {
    const browser = await firefox.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await context.newPage()
    await page.goto("https://google.com", { waitUntil: "networkidle" })
    sessions[room] = { browser, context, page, frame: 0 }
    clients[room] = new Set()
  }

  const { page } = sessions[room]
  clients[room].add(ws)
  activity[room] = Date.now()

  ws.send(JSON.stringify({ type: "status", text: "connected boi" }))
  ws.send(JSON.stringify({ type: "ready" }))

  let locked = false

  const sendFrame = async () => {
    if (ws.readyState !== WebSocket.OPEN || locked) return
    locked = true

    try {
      const buf = await page.screenshot({ type: "jpeg", quality: 60, timeout: 8000 })
      sessions[room].frame++
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "screenshot", data: buf.toString("base64"), frame: sessions[room].frame }))
      }
    } catch (e) {}

    locked = false
  }

  const interval = setInterval(sendFrame, 1000 / 22)
  sendFrame()

  ws.on("message", async data => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    activity[room] = Date.now()

    if (msg.type === "mouse") {
      if (msg.action === "move") await page.mouse.move(msg.x, msg.y)
      if (msg.action === "down") {
        await page.mouse.move(msg.x, msg.y)
        await page.mouse.down({ button: msg.button })
      }
      if (msg.action === "up") {
        await page.mouse.move(msg.x, msg.y)
        await page.mouse.up({ button: msg.button })
      }
    }

    if (msg.type === "keyboard") {
      if (msg.action === "down") await page.keyboard.down(msg.key)
      if (msg.action === "up") await page.keyboard.up(msg.key)
    }

    if (msg.type === "cursor" && clients[room]) {
      for (const c of clients[room]) {
        if (c !== ws && c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: "cursor", id: msg.id, x: msg.x, y: msg.y }))
        }
      }
    }
  })

  ws.on("close", () => {
    clients[room]?.delete(ws)
    clearInterval(interval)
    if (clients[room]?.size === 0) activity[room] = Date.now() - 3 * 60 * 1000
  })
})

setInterval(() => {
  const now = Date.now()
  for (const room in sessions) {
    const empty = !clients[room] || clients[room].size === 0
    const inactive = now - (activity[room] || 0) > 3 * 60 * 1000
    if (empty && inactive) {
      sessions[room].browser.close().catch(() => {})
      delete sessions[room]
      delete clients[room]
      delete activity[room]
    }
  }
}, 30000)

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`the browser of proxu is runnin on the ${PORT}`))
