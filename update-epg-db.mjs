// update-epg-db.mjs
import fs from "fs";
import path from "path";

// Channels to fetch from the API path
const CHANNEL_IDS = [239, 681, 433, 138, 681, 238, 119, 127, 867, 1340, 118, 114, 45, 144, 587]; // add more, e.g. [239, 114, 240, 241]

const BASE_URL =
  "https://ts-more-api.videoready.tv/content-detail/pub/api/v6/channels";

const OUTPUT_DIR = path.join(process.cwd(), "data");

// Ensure data folder exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log("Created data directory");
}

async function fetchChannel(pathId) {
  const url = `${BASE_URL}/${pathId}?platform=WEB`;
  console.log("Fetching:", url);

  const res = await fetch(url);
  console.log("HTTP status for", pathId, "=>", res.status);

  if (!res.ok) return null;
  return res.json();
}

function loadExistingChannelFile(channelId, channelName) {
  const filePath = path.join(OUTPUT_DIR, `${channelId}.json`);

  if (!fs.existsSync(filePath)) {
    // New file structure
    return {
      filePath,
      json: {
        channelId,
        channelName,
        channelScheduleData: [] // array of {title, boxCoverImage}
      }
    };
  }

  const content = fs.readFileSync(filePath, "utf8");
  try {
    const parsed = JSON.parse(content);
    // Make sure structure exists
    if (!Array.isArray(parsed.channelScheduleData)) {
      parsed.channelScheduleData = [];
    }
    parsed.channelId ??= channelId;
    parsed.channelName ??= channelName;
    return { filePath, json: parsed };
  } catch {
    // If file is broken, recreate
    return {
      filePath,
      json: {
        channelId,
        channelName,
        channelScheduleData: []
      }
    };
  }
}

async function processChannel(pathId) {
  const apiData = await fetchChannel(pathId);
  if (!apiData || apiData.code !== 0) return;

  const data = apiData.data || {};
  const channelMeta = data.channelMeta;
  const scheduleRaw = Array.isArray(data.channelScheduleData)
    ? data.channelScheduleData
    : [];

  if (!channelMeta?.id) {
    console.log("No channelMeta.id for path id", pathId);
    return;
  }

  const channelId = channelMeta.id;         // e.g. 239
  const channelName = channelMeta.name || ""; // e.g. "Pogo"

  // Load existing JSON (if any)
  const { filePath, json } = loadExistingChannelFile(channelId, channelName);

  // Build a set of existing titles to avoid duplicates
  const existingTitles = new Set(
    (json.channelScheduleData || []).map(item => item.title)
  );

  // From API schedule: map to {title, boxCoverImage} and only keep new titles
  let addedCount = 0;
  for (const item of scheduleRaw) {
    const title = (item.title || "").trim();
    const boxCoverImage = item.boxCoverImage || "";

    if (!title || !boxCoverImage) continue;
    if (existingTitles.has(title)) continue; // skip duplicates

    json.channelScheduleData.push({ title, boxCoverImage });
    existingTitles.add(title);
    addedCount++;
  }

  fs.writeFileSync(filePath, JSON.stringify(json, null, 2), "utf8");
  console.log(
    `✅ ${filePath}: added ${addedCount} new titles, total = ${json.channelScheduleData.length}`
  );
}

async function main() {
  for (const id of CHANNEL_IDS) {
    await processChannel(id);
  }
}

main();
