const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const users = [];
const plansByUserId = new Map();
let nextUserId = 1;

app.use(
  cors({
    origin(origin, callback) {
      // Allow server-to-server requests and local tooling without Origin header.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origen no permitido por CORS."));
    },
  })
);
app.use(express.json({ limit: "5mb" }));

function createToken(user) {
  return jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
  };
}

function authRequired(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const [type, token] = authHeader.split(" ");

  if (type !== "Bearer" || !token) {
    return res.status(401).json({ message: "Token requerido." });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.find((item) => item.id === payload.userId);

    if (!user) {
      return res.status(401).json({ message: "Usuario no encontrado." });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: "Token invalido o vencido." });
  }
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Nombre, email y password son requeridos." });
  }

  if (password.length < 6) {
    return res.status(400).json({ message: "El password debe tener al menos 6 caracteres." });
  }

  const existingUser = users.find((user) => user.email === email);
  if (existingUser) {
    return res.status(409).json({ message: "Ya existe un usuario con ese email." });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: nextUserId,
    name,
    email,
    passwordHash,
  };

  nextUserId += 1;
  users.push(user);
  plansByUserId.set(user.id, {
    cycles: [],
    config: null,
    activeWeekStart: null,
  });

  res.status(201).json({
    token: createToken(user),
    user: publicUser(user),
  });
});

app.post("/api/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");

  if (!email || !password) {
    return res.status(400).json({ message: "Email y password son requeridos." });
  }

  const user = users.find((item) => item.email === email);
  if (!user) {
    return res.status(401).json({ message: "Credenciales invalidas." });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ message: "Credenciales invalidas." });
  }

  res.json({
    token: createToken(user),
    user: publicUser(user),
  });
});

app.get("/api/plan", authRequired, (req, res) => {
  const plan = plansByUserId.get(req.user.id) || {
    cycles: [],
    config: null,
    activeWeekStart: null,
  };

  res.json(plan);
});

app.post("/api/plan", authRequired, (req, res) => {
  const plan = {
    cycles: Array.isArray(req.body.cycles) ? req.body.cycles : [],
    config: req.body.config && typeof req.body.config === "object" ? req.body.config : null,
    activeWeekStart: typeof req.body.activeWeekStart === "string" ? req.body.activeWeekStart : null,
  };

  plansByUserId.set(req.user.id, plan);
  res.json({ message: "Plan guardado.", plan });
});

app.listen(PORT, () => {
  console.log(`Backend listo en http://localhost:${PORT}`);
});
