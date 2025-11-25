// scripts/update-epg.mjs
import fs from "fs";
import path from "path";
import zlib from "zlib";

const EPG_SOURCES = [
  "https://tsepg.cf/jio.xml.gz",
  "http://tsepg.cf/epg.xml.gz",
];

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Parse XMLTV timestamp → Date (UTC)
// Supports: "YYYYMMDDHHMMSS", "YYYYMMDDHHMMSS Z", "YYYYMMDDHHMMSS +0530", "YYYYMMDDHHMMSS+0530"
function parseXmltvTime(ts) {
  if (!ts) return null;
  ts = String(ts).trim();

  // Match base datetime + optional timezone part
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

  // Start as if time is in UTC
  let utcMillis = Date.UTC(y, mo, d, h, min, s);

  if (tz && tz.toUpperCase() !== "Z") {
    // "+0530", "+05:30", "-0100", etc.
    const tzClean = tz.replace(":", "");
    const sign = tzClean[0] === "-" ? -1 : 1;
    const hh = Number(tzClean.slice(1, 3));
    const mm = Number(tzClean.slice(3, 5));
    const offsetMinutes = sign * (hh * 60 + mm);
    // Convert local-with-offset → UTC
    utcMillis -= offsetMinutes * 60 * 1000;
  }

  return new Date(utcMillis);
}

// Convert XMLTV timestamp string → "YYYY-MM-DD HH:MM:SS IST"
function formatTimeIST(originalTs) {
  const dateUtc = parseXmltvTime(originalTs);
  if (!dateUtc) return originalTs || "";

  // IST = UTC + 5:30
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

async function downloadAndParseEPG(url) {
  console.log("Downloading:", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${url}): ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  console.log("Decompressing…");
  const xmlBuffer = zlib.gunzipSync(buffer);
  const xmlText = xmlBuffer.toString("utf8");

  console.log("Parsing XML…");
  const programmes = parseEPGProgrammes(xmlText);
  console.log(`Parsed programmes from ${url}: ${programmes.length}`);

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
    const allProgrammes = [];
    const sourcesMeta = [];

    // download+parse all sources
    for (const url of EPG_SOURCES) {
      const programmes = await downloadAndParseEPG(url);
      allProgrammes.push(...programmes);
      sourcesMeta.push({ url, count: programmes.length });
    }

    console.log("Total merged programmes:", allProgrammes.length);

    const byChannel = groupByChannel(allProgrammes);

    const outRoot = path.join(process.cwd(), "public");
    const epgDir = path.join(outRoot, "epg");
    ensureDir(outRoot);
    ensureDir(epgDir);

    const channelsIndex = [];

    console.log("Writing per-channel JSON files (with IST times)...");
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
      totalProgrammes: allProgrammes.length,
      totalChannels: channelsIndex.length,
      timeZone: "Asia/Kolkata (IST, UTC+5:30)",
      note: "start/stop fields are formatted in IST; startRaw/stopRaw hold original XMLTV timestamps.",
      sources: sourcesMeta,
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
