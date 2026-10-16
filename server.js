
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { AccessToken } = require("livekit-server-sdk");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

app.set("trust proxy", 1);
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false }));

if (!DATABASE_URL || !SESSION_SECRET) {
  console.error("DATABASE_URL va SESSION_SECRET sozlanishi kerak.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false"
    ? false
    : { rejectUnauthorized: false }
});

app.use(session({
  store: new pgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(254) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id BIGSERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(254) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Avval tizimga kiring." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin ruxsati kerak." });
  }
  next();
}

app.post("/api/register", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (name.length < 2 || name.length > 100) {
      return res.status(400).json({ error: "Ism 2–100 belgi bo‘lsin." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: "Email manzil noto‘g‘ri." });
    }

    if (password.length < 10 || password.length > 72) {
      return res.status(400).json({
        error: "Parol kamida 10 ta belgi bo‘lishi kerak."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email, role, email_verified`,
      [name, email, passwordHash]
    );

    res.status(201).json({
      message: "Ro‘yxatdan o‘tish muvaffaqiyatli. Email tasdiqlash hali sozlanmagan.",
      user: result.rows[0]
    });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Bu email oldin ro‘yxatdan o‘tgan." });
    }
    console.error("Register xatosi:", error);
    res.status(500).json({ error: "Serverda xatolik yuz berdi." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, email_verified
       FROM users WHERE email = $1`,
      [email]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: "Email yoki parol noto‘g‘ri." });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error(error);
        return res.status(500).json({ error: "Sessiya yaratilmadi." });
      }

      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role
      };

      req.session.save((saveError) => {
        if (saveError) {
          console.error(saveError);
          return res.status(500).json({ error: "Kirish saqlanmadi." });
        }

        res.json({
          message: "Tizimga kirdingiz.",
          user: req.session.user,
          emailVerified: user.email_verified
        });
      });
    });
  } catch (error) {
    console.error("Login xatosi:", error);
    res.status(500).json({ error: "Serverda xatolik yuz berdi." });
  }
});

app.get("/api/me", requireLogin, (req, res) => {
  res.json({ user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({ error: "Chiqishda xatolik." });
    }

    res.clearCookie("connect.sid");
    res.json({ message: "Tizimdan chiqdingiz." });
  });
});

app.post("/api/contact", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const message = String(req.body.message || "").trim();

    if (
      name.length < 2 || name.length > 100 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      message.length < 5 || message.length > 5000
    ) {
      return res.status(400).json({ error: "Ma’lumotlarni tekshirib qayta kiriting." });
    }

    await pool.query(
      `INSERT INTO contact_messages (name, email, message)
       VALUES ($1, $2, $3)`,
      [name, email, message]
    );

    res.status(201).json({ message: "Xabaringiz yuborildi." });
  } catch (error) {
    console.error("Contact xatosi:", error);
    res.status(500).json({ error: "Xabar saqlanmadi." });
  }
});

app.get("/api/admin/messages", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, message, created_at
       FROM contact_messages ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ messages: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Xabarlarni olishda xatolik." });
  }
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, role, email_verified, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ users: result.rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Foydalanuvchilarni olishda xatolik." });
  }
});

app.post("/livekit-token", async (req, res) => {
  try {
    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(503).json({ error: "LiveKit sozlanmagan." });
    }

    const room = "TanishamizLive";
    const identity = req.session.user
      ? "user-" + req.session.user.id
      : "guest-" + require("crypto").randomUUID();

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      { identity, ttl: "1h" }
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
    console.error("LiveKit xatosi:", error);
    res.status(500).json({ error: "Token yaratilmadi." });
  }
});

io.on("connection", (socket) => {
  console.log("Socket ulandi:", socket.id);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "AFTOR" });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Serverda kutilmagan xatolik." });
});

initDatabase()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log("AFTOR server ishga tushdi:", PORT);
    });
  })
  .catch((error) => {
    console.error("Ma’lumotlar bazasi ishga tushmadi:", error);
    process.exit(1);
  });
