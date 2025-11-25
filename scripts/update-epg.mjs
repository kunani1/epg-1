// scripts/update-epg.mjs
import fs from "fs";
import path from "path";
import zlib from "zlib";

const EPG_URL = "https://tsepg.cf/jio.xml.gz";

function stripTags(s) {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// Parse XMLTV <programme> entries (similar to your worker)
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

    programmes.push({
      start: attrs.start ?? "",
      stop: attrs.stop ?? "",
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

    const outRoot = path.join(process.cwd(), "public");
    const epgDir = path.join(outRoot, "epg");
    ensureDir(outRoot);
    ensureDir(epgDir);

    const channelsIndex = [];

    console.log("Writing per-channel JSON files…");
    for (const [channelId, list] of byChannel.entries()) {
      const outPath = path.join(epgDir, `${channelId}.json`);
      fs.writeFileSync(outPath, JSON.stringify(list, null, 2), "utf8");
      channelsIndex.push({ channel: channelId, count: list.length });
    }

    // Sort channel index for convenience
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
