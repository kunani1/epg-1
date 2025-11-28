// scripts/update-epg.mjs
import fs from "fs";
import path from "path";
import zlib from "zlib";

const EPG_URL = "https://tsepg.cf/jio.xml.gz";

// === IMAGES SETUP ===

// Folder where your TataPlay image DB JSONs live
// Example file: data/239.json, data/114.json, ...
const IMAGE_DB_DIR = path.join(process.cwd(), "data");

// Map EPG channel id (from XML, e.g. "jio_539") → image DB id (file name like 239)
const CHANNEL_IMAGE_ID_MAP = {
  "jio-559": 239, // jio_539 in XML should use data/239.json
  // add more: "jio_123": 114, etc.
};

// Default image if no specific poster found for a title
const DEFAULT_IMAGE =
  "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/TV_icon_black.svg/512px-TV_icon_black.svg.png";

// Load a single image DB file and build title -> image map
function loadImageMapFile(fileId) {
  const filePath = path.join(IMAGE_DB_DIR, `${fileId}.json`);
  if (!fs.existsSync(filePath)) {
    console.log("Image DB file not found:", filePath);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    console.log("Error parsing image DB JSON:", filePath, e.message);
    return null;
  }

  const schedule = Array.isArray(parsed.channelScheduleData)
    ? parsed.channelScheduleData
    : [];

  const map = new Map();
  for (const item of schedule) {
    const title = (item.title || "").trim().toLowerCase();
    const img = item.boxCoverImage || "";
    if (!title || !img) continue;
    if (!map.has(title)) {
      map.set(title, img);
    }
  }

  console.log(`Loaded ${map.size} titles from`, filePath);
  return map;
}

// Attach image URLs to programmes based on channel + title
function attachImagesToProgrammes(byChannel) {
  const imageMapCache = new Map(); // fileId -> Map(title -> img)

  for (const [epgChannelId, programmes] of byChannel.entries()) {
    // 1) Find which image DB file to use for this EPG channel
    let imageFileId = CHANNEL_IMAGE_ID_MAP[epgChannelId];

    // 2) Optional fallback: if no mapping, try file with the same name as the EPG channel
    if (!imageFileId) {
      const directPath = path.join(IMAGE_DB_DIR, `${epgChannelId}.json`);
      if (fs.existsSync(directPath)) {
        imageFileId = epgChannelId;
      }
    }

    let titleToImage = null;

    if (imageFileId) {
      titleToImage = imageMapCache.get(imageFileId);
      if (!titleToImage) {
        titleToImage = loadImageMapFile(imageFileId);
        imageMapCache.set(imageFileId, titleToImage || null);
      }
    }

    // For every programme on this channel, assign an image
    for (const prog of programmes) {
      const key = (prog.title || "").trim().toLowerCase();
      let img = null;

      // 1. Try to find exact title match in that channel's image DB
      if (titleToImage && key && titleToImage.has(key)) {
        img = titleToImage.get(key);
      }

      // 2. If not found, use default
      if (!img) {
        img = DEFAULT_IMAGE;
      }

      // Attach to programme
      // Use "image" field; change to "boxCoverImage" if you prefer that name in EPG JSON
      prog.image = img;
    }
  }
}

// === END IMAGES SETUP ===

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Parse XMLTV timestamp → Date (UTC)
function parseXmltvTime(ts) {
  if (!ts) return null;
  ts = String(ts).trim();

  const m = ts.match(/^(\d{14})(?:\s*([+-]\d{2}:?\d{2}|[+-]\d{4}|Z))?/i);
  if (!m) return null;

  const dt = m[1];
  const tz = m[2] ?? null;

  const y = Number(dt.slice(0, 4));
  const mo = Number(dt.slice(4, 6)) - 1;
  const d = Number(dt.slice(6, 8));
  const h = Number(dt.slice(8, 10));
  const min = Number(dt.slice(10, 12));
  const s = Number(dt.slice(12, 14));

  let utcMillis = Date.UTC(y, mo, d, h, min, s);

  if (tz && tz.toUpperCase() !== "Z") {
    const tzClean = tz.replace(":", "");
    const sign = tzClean[0] === "-" ? -1 : 1;
    const hh = Number(tzClean.slice(1, 3));
    const mm = Number(tzClean.slice(3, 5));
    const offsetMinutes = sign * (hh * 60 + mm);
    utcMillis -= offsetMinutes * 60 * 1000;
  }

  return new Date(utcMillis);
}

// Convert XMLTV timestamp string → "YYYY-MM-DD HH:MM:SS IST"
function formatTimeIST(originalTs) {
  const dateUtc = parseXmltvTime(originalTs);
  if (!dateUtc) return originalTs || "";

  const istMillis = dateUtc.getTime() + 5.5 * 3600 * 1000;
  const ist = new Date(istMillis);

  const yyyy = ist.getFullYear();
  const mm = String(ist.getMonth() + 1).padStart(2, "0");
  const dd = String(ist.getDate()).padStart(2, "0");
  const hh = String(ist.getHours()).padStart(2, "0");
  const mi = String(ist.getMinutes()).padStart(2, "0");
  const ss = String(ist.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} IST`;
}

// Parse XMLTV <programme> entries and convert times to IST
function parseEPGProgrammes(xml) {
  const programmes = [];
  const progRegex = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  let match;
  while ((match = progRegex.exec(xml)) !== null) {
    const attrText = match[1];
    const inner = match[2];

    const attrs = Object.fromEntries(
      [...attrText.matchAll(/([\w:\-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]])
    );

    const titleMatch = inner.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const subtitleMatch = inner.match(
      /<(?:sub-title|sub_title)[^>]*>([\s\S]*?)<\/(?:sub-title|sub_title)>/i
    );

    const startRaw = attrs.start ?? "";
    const stopRaw = attrs.stop ?? "";

    programmes.push({
      startRaw,
      stopRaw,
      start: formatTimeIST(startRaw), // IST formatted string
      stop: formatTimeIST(stopRaw),   // IST formatted string
      channel: attrs.channel ?? attrs["channel"] ?? "",
      title: titleMatch ? stripTags(titleMatch[1]).trim() : "Untitled",
      subTitle: subtitleMatch ? stripTags(subtitleMatch[1]).trim() : ""
    });
  }
  return programmes;
}

async function downloadAndParseEPG() {
  console.log("Downloading:", EPG_URL);
  const res = await fetch(EPG_URL);
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log("Decompressing…");
  const xmlBuffer = zlib.gunzipSync(buffer);
  const xmlText = xmlBuffer.toString("utf8");

  console.log("Parsing XML…");
  const programmes = parseEPGProgrammes(xmlText);
  console.log(`Parsed programmes: ${programmes.length}`);

  return programmes;
}

function groupByChannel(programmes) {
  const map = new Map();
  for (const p of programmes) {
    const ch = p.channel || "unknown";
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch).push(p);
  }
  return map;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main() {
  try {
    const programmes = await downloadAndParseEPG();
    const byChannel = groupByChannel(programmes);

    // Attach images (from data/*.json) to programmes based on channel+title
    attachImagesToProgrammes(byChannel);

    const outRoot = path.join(process.cwd(), "public");
    const epgDir = path.join(outRoot, "epg");
    ensureDir(outRoot);
    ensureDir(epgDir);

    const channelsIndex = [];

    console.log("Writing per-channel JSON files (with IST times + images)...");
    for (const [channelId, list] of byChannel.entries()) {
      const outPath = path.join(epgDir, `${channelId}.json`);
      fs.writeFileSync(outPath, JSON.stringify(list, null, 2), "utf8");
      channelsIndex.push({ channel: channelId, count: list.length });
    }

    channelsIndex.sort((a, b) => a.channel.localeCompare(b.channel));

    // channels index
    fs.writeFileSync(
      path.join(outRoot, "channels.json"),
      JSON.stringify(channelsIndex, null, 2),
      "utf8"
    );

    // meta info
    const meta = {
      lastUpdate: new Date().toISOString(),
      totalProgrammes: programmes.length,
      totalChannels: channelsIndex.length,
      timeZone: "Asia/Kolkata (IST, UTC+5:30)",
      note:
        "start/stop fields are formatted in IST; startRaw/stopRaw hold original XMLTV timestamps. 'image' field comes from TataPlay image DB or default.",
      source: EPG_URL
    };
    fs.writeFileSync(
      path.join(outRoot, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    console.log("Done!");
    console.log(`Channels: ${channelsIndex.length}`);
  } catch (err) {
    console.error("EPG update failed:", err);
    process.exit(1);
  }
}

main();
