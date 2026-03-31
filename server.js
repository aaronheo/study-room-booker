const express = require("express");
const path = require("path");
const { bookRoom, getReservations, checkAvailability, hasCachedSession } = require("./booker");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// SSE connections for live status updates
const clients = new Map();
const pendingMessages = new Map();

app.get("/api/status/:id", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Flush any messages that were buffered before the client connected
  const buffered = pendingMessages.get(req.params.id);
  if (buffered) {
    for (const msg of buffered) {
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    }
    pendingMessages.delete(req.params.id);
  }

  clients.set(req.params.id, res);
  req.on("close", () => clients.delete(req.params.id));
});

function sendStatus(id, data) {
  const client = clients.get(id);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  } else {
    // Client hasn't connected yet — buffer the message
    if (!pendingMessages.has(id)) pendingMessages.set(id, []);
    pendingMessages.get(id).push(data);
  }
}

function validateDuration(startTime, endTime) {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  const diffMins = (eh * 60 + em) - (sh * 60 + sm);
  if (diffMins <= 0) return "End time must be after start time.";
  if (diffMins > 180) return "Maximum booking duration is 3 hours.";
  return null;
}

app.post("/api/book", async (req, res) => {
  const { date, startTime, endTime, room } = req.body;

  const timeError = validateDuration(startTime, endTime);
  if (timeError) {
    return res.status(400).json({ error: timeError });
  }

  // Use environment variables for credentials
  const username = process.env.UTAH_UID;
  const password = process.env.PASSWORD;

  if (!username || !password) {
    return res.status(500).json({ error: "UTAH_UID and PASSWORD environment variables are not set" });
  }

  const jobId = Date.now().toString(36);
  res.json({ jobId });

  try {
    const result = await bookRoom(
      {
        username,
        password,
        date,
        startTime,
        endTime,
        room,
      },
      (msg) => sendStatus(jobId, { status: "progress", message: msg })
    );

    sendStatus(jobId, { status: "done", ...result });
  } catch (err) {
    sendStatus(jobId, { status: "error", message: err.message });
  }
});

app.post("/api/availability", async (req, res) => {
  const { date, startTime, endTime } = req.body;

  const username = process.env.UTAH_UID;
  const password = process.env.PASSWORD;

  if (!username || !password) {
    return res.status(500).json({ error: "UTAH_UID and PASSWORD environment variables are not set" });
  }

  const jobId = Date.now().toString(36) + "a";
  res.json({ jobId });

  try {
    const result = await checkAvailability(
      { username, password, date, startTime, endTime },
      (msg) => sendStatus(jobId, { status: "progress", message: msg })
    );
    sendStatus(jobId, { status: "done", ...result });
  } catch (err) {
    sendStatus(jobId, { status: "error", message: err.message });
  }
});

app.get("/api/session-status", (req, res) => {
  res.json({ hasCachedSession: hasCachedSession() });
});

app.post("/api/reservations", async (req, res) => {
  const username = process.env.UTAH_UID;
  const password = process.env.PASSWORD;

  if (!username || !password) {
    return res.status(500).json({ error: "UTAH_UID and PASSWORD environment variables are not set" });
  }

  const jobId = Date.now().toString(36) + "r";
  res.json({ jobId });

  try {
    const result = await getReservations(
      { username, password },
      (msg) => sendStatus(jobId, { status: "progress", message: msg })
    );
    sendStatus(jobId, { status: "done", ...result });
  } catch (err) {
    sendStatus(jobId, { status: "error", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Study Room Booker running at http://localhost:${PORT}`);
});
