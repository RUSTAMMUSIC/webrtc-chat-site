
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get("/", (req, res) => {
  res.send(`
    <h1>Video qo‘ng‘iroq va chat</h1>
    <p>Sayt serveri ishlayapti!</p>
  `);
});

io.on("connection", (socket) => {
  console.log("Foydalanuvchi ulandi:", socket.id);

  socket.on("join-room", (room) => {
    socket.join(room);
    socket.to(room).emit("user-joined", socket.id);
  });

  socket.on("disconnect", () => {
    console.log("Foydalanuvchi uzildi");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server ${PORT} portda ishga tushdi`);
});
