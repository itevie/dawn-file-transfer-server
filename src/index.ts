import fs from "fs";
import config from "./config";
import express from "express";
import multer from "multer";
import { fileTypeFromFile } from "file-type";
import { randomUUID } from "crypto";
import { AccessCode, AccessLink, DawnFile, db, initDb } from "./db";
import path from "path";
import rateLimit from "express-rate-limit";
import cors from "cors";

if (!fs.existsSync(config.dataPath)) fs.mkdirSync(config.dataPath);
if (!fs.existsSync(config.dataPath + "/files"))
  fs.mkdirSync(config.dataPath + "/files");

const app = express();
app.use(cors());
export const upload = multer({
  dest: "uploads/",
  limits: { fileSize: config.maxFileSize, files: 1 },
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});

app.use(limiter);

function makeCode(): string {
  let chars = "0123456789";
  let value = "";

  for (let i = 0; i != 6; i++)
    value += chars[Math.floor(Math.random() * chars.length)];

  return value;
}
app.post("/upload", upload.single("files"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }

  const detected = await fileTypeFromFile(req.file.path);

  const mime = detected?.mime || "application/octet-stream";
  const size = req.file.size;
  const name = path.basename(req.file.originalname);
  const storedName = randomUUID();
  const now = new Date().toISOString();

  fs.renameSync(req.file.path, path.join(config.dataPath, "files", storedName));

  const dawnFile = db
    .prepare<[string, string, string, string, number], DawnFile>(
      `
      INSERT INTO files (id, file_name, mime_type, added_at, size)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `,
    )
    .get(storedName, name, mime, now, size);

  const dawnCode = db
    .prepare<[string, string, string, number], AccessCode>(
      `
      INSERT INTO access_codes (code, file, added_at, expires)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `,
    )
    .get(makeCode(), storedName, now, config.expireCode);

  return res.json({
    access_code: dawnCode?.code,
    file_name: dawnFile?.file_name,
    size: dawnFile?.size,
  });
});

app.get("/download", (req, res) => {
  const queryCode = (req.query.code ?? req.query.link)?.toString();

  if (!queryCode) {
    return res.status(400).json({ message: "Missing access code or link" });
  }

  const access =
    db
      .prepare<
        [string],
        AccessCode
      >("SELECT * FROM access_codes WHERE code = ?")
      .get(queryCode) ??
    db
      .prepare<
        [string],
        AccessLink
      >("SELECT * FROM access_links WHERE code = ?")
      .get(queryCode);

  if (!access) {
    return res.status(404).json({ message: "Invalid code" });
  }

  const accessAge = Date.now() - new Date(access.added_at).getTime();

  if (accessAge > access.expires) {
    db.prepare("DELETE FROM access_codes WHERE code = ?").run(queryCode);
    db.prepare("DELETE FROM access_links WHERE code = ?").run(queryCode);
    return res.status(400).json({ message: "Access expired" });
  }

  const file = db
    .prepare<[string], DawnFile>("SELECT * FROM files WHERE id = ?")
    .get(access.file);

  if (!file) {
    return res.status(500).json({ message: "File missing" });
  }

  const filePath = path.join(config.dataPath, "files", file.id);

  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ message: "File missing on disk" });
  }

  db.prepare("DELETE FROM access_codes WHERE code = ?").run(queryCode);

  res.type(file.mime_type);
  return res.download(filePath, file.file_name);
});

app.get("/files", (req, res) => {
  const queryCode = (req.query.code ?? req.query.link)?.toString();

  if (!queryCode) {
    return res.status(400).json({ message: "Missing access code or link" });
  }

  const access =
    db
      .prepare<
        [string],
        AccessCode
      >("SELECT * FROM access_codes WHERE code = ?")
      .get(queryCode) ??
    db
      .prepare<
        [string],
        AccessLink
      >("SELECT * FROM access_links WHERE code = ?")
      .get(queryCode);

  if (!access) {
    return res.status(404).json({ message: "Invalid code" });
  }

  const accessAge = Date.now() - new Date(access.added_at).getTime();

  if (accessAge > access.expires) {
    db.prepare("DELETE FROM access_codes WHERE code = ?").run(queryCode);
    db.prepare("DELETE FROM access_links WHERE code = ?").run(queryCode);
    return res.status(400).json({ message: "Access expired" });
  }

  const file = db
    .prepare<[string], DawnFile>("SELECT * FROM files WHERE id = ?")
    .get(access.file);

  if (!file) {
    return res.status(500).json({ message: "File missing" });
  }

  const filePath = path.join(config.dataPath, "files", file.id);

  if (!fs.existsSync(filePath)) {
    return res.status(500).json({ message: "File missing on disk" });
  }

  return res.status(200).send({
    file,
  });
});

app.post("/files/:file/link", (req, res) => {
  const file = db
    .prepare<[string], DawnFile>("SELECT * FROM files WHERE id = ?")
    .get(req.params.file);

  if (!file) {
    return res.status(404).json({ message: "Invalid file" });
  }

  const now = new Date().toISOString();

  const link = db
    .prepare<[string, string, string, number], AccessLink>(
      `
      INSERT INTO access_links (code, file, added_at, expires)
      VALUES (?, ?, ?, ?)
      RETURNING *
    `,
    )
    .get(randomUUID(), file.id, now, config.expireLink);

  return res.json({ link: link?.code });
});

initDb();

setInterval(
  () => {
    const now = Date.now();

    // Remove expired access_codes
    db.prepare(
      `
    DELETE FROM access_codes
    WHERE (? - strftime('%s', added_at) * 1000) > expires
  `,
    ).run(now);

    // Remove expired access_links
    db.prepare(
      `
    DELETE FROM access_links
    WHERE (? - strftime('%s', added_at) * 1000) > expires
  `,
    ).run(now);

    // Delete files with no access left
    const orphanFiles = db
      .prepare<[], DawnFile>(
        `
    SELECT id FROM files
    WHERE id NOT IN (
      SELECT file FROM access_codes
      UNION
      SELECT file FROM access_links
    )
  `,
      )
      .all();

    for (const f of orphanFiles) {
      fs.unlink(path.join(config.dataPath, "files", f.id), () => {});
      db.prepare("DELETE FROM files WHERE id = ?").run(f.id);
    }
  },
  60 * 60 * 1000,
);

app.listen(config.port, () => {
  console.log(`Listening on port ${config.port}`);
});
