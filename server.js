```javascript
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.use(express.json());

app.post("/livekit-token", async (req, res) => {
  try {
    const room = "TanishamizLive";
    const identity = "guest-" + Math.random().toString(36).slice(2, 10);

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity }
    );

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true
    });

    res.json({
      token: await token.toJwt(),
      url: process.env.LIVEKIT_URL,
      room
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Token yaratilmadi" });
  }
});

io.on("connection", (socket) => {
  console.log("Foydalanuvchi ulandi:", socket.id);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server ishga tushdi:", PORT);
});
```
