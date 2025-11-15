import { BorshCoder } from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Configuration ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");

// The event data you pasted from your log
const EVENT_BASE64 = "ZiwA4aNup7sYAAAAcmVxXzE3NjMyMDM4NDY4NThfMHQ1ZzRwJc1oZSmjQnGwgHYU+knL17B7YdJkWmD9Ez4AR2DQ8QkGAAAAb3BlbmFpBQAAAGdwdC00AQAAAAQAAAB1c2VyHAAAAFdoYXQgaXMgdGhlIG1lYW5pbmcgb2YgbGlmZT8=";
const EVENT_NAME = "RequestCreated";

/**
 * Loads and parses the IDL file
 */
function loadIdl() {
  if (!fs.existsSync(IDL_PATH)) {
    console.error(`❌ IDL file not found at ${IDL_PATH}`);
    return null;
  }
  try {
    const idlContent = fs.readFileSync(IDL_PATH, "utf8");
    return JSON.parse(idlContent);
  } catch (e) {
    console.error(`❌ Failed to parse IDL: ${e.message}`);
    return null;
  }
}

/**
 * Main function to run the decoder
 */
function main() {
  console.log("🚀 Starting Manual Event Decoder...");

  const idl = loadIdl();
  if (!idl) {
    console.error("Stopping due to missing IDL.");
    return;
  }

  console.log(`\n🔍 Attempting to decode event: "${EVENT_NAME}"`);

  // 1. Find the event definition in your local IDL
  const eventDef = idl.events.find(e => e.name === EVENT_NAME);
  if (!eventDef) {
    console.error(`❌ Event "${EVENT_NAME}" not found in your IDL!`);
    console.error("   This also proves your IDL is out of sync.");
    return;
  }

  console.log("\nFound event definition in `coolrouter.json`:");
  console.log("-----------------------------------------------");
  console.log(JSON.stringify(eventDef, null, 2));
  console.log("-----------------------------------------------");

  // 2. Prepare the raw event data from the log
  const fullBuffer = Buffer.from(EVENT_BASE64, 'base64');
  // Anchor event data is the full buffer *minus* the 8-byte discriminator
  const eventData = fullBuffer.slice(8);
  
  console.log(`\n[DEBUG] Full buffer length: ${fullBuffer.length} bytes`);
  console.log(`[DEBUG] Data buffer to decode (no discriminator): ${eventData.length} bytes`);

  // 3. Try to decode the data using the IDL's definition
  try {
    const coder = new BorshCoder(idl);
    const decodedEvent = coder.events.decode(EVENT_NAME, eventData);

    console.log("\n✅ DECODING SUCCEEDED!");
    console.log(JSON.stringify(decodedEvent, null, 2));
    console.log("\nWait, this shouldn't happen. If this worked, your `listen.js` script should also work.");

  } catch (error) {
    console.log("\n---");
    console.error("❌ DECODING FAILED!");
    console.error("\nError Message:", error.message);
    console.log("\n---");
    console.log("This error proves that your `coolrouter.json` IDL file is out of sync.");
    console.log("The data from the log does not match the event struct definition in your IDL (printed above).");
    console.log("\n➡️ TO FIX THIS: You MUST run `anchor build` to regenerate the IDL.");
  }
}

main();