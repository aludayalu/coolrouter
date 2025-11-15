import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// --- Configuration ---
const COOLROUTER_PROGRAM_ID = "DwPxc47Ss4Tyt3q8oT1pu58od2KjB5ZpSihQM3432Dqm";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");

// --- Dynamic Parser Class ---
class BorshBufferParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readU32() {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readString() {
    const length = this.readU32();
    if (length === 0) return "";
    if (this.offset + length > this.buffer.length) {
      throw new Error("Buffer out of bounds trying to read string");
    }
    const strBuffer = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return strBuffer.toString("utf8");
  }

  readPubkey() {
    if (this.offset + 32 > this.buffer.length) {
      throw new Error("Buffer out of bounds trying to read pubkey");
    }
    const pubkeyBuffer = this.buffer.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(pubkeyBuffer);
  }

  // Dynamically reads a struct based on a field layout
  readStruct(fields) {
    const struct = {};
    for (const field of fields) {
      if (field.type === "string") {
        struct[field.name] = this.readString();
      } else if (field.type === "pubkey") {
        struct[field.name] = this.readPubkey();
      }
      // Add other types (u64, etc.) here if needed
    }
    return struct;
  }

  // Dynamically reads a Vec<Struct>
  readStructVec(fields) {
    const length = this.readU32();
    const items = [];
    for (let i = 0; i < length; i++) {
      items.push(this.readStruct(fields));
    }
    return items;
  }
}

function modify_idl(idl_object) {
  if (!idl_object || !Array.isArray(idl_object.types) || !Array.isArray(idl_object.events)) {
    console.error("Invalid IDL object structure. Missing 'types' or 'events' array.");
    return idl_object;
  }

  // Create a map of types by name for efficient lookup.
  const typeMap = new Map();
  for (const typeDef of idl_object.types) {
    if (typeDef && typeDef.name) {
      typeMap.set(typeDef.name, typeDef);
    }
  }

  // Iterate over each event and populate its fields from the type map.
  for (const event of idl_object.events) {
    if (event && event.name && typeMap.has(event.name)) {
      const correspondingType = typeMap.get(event.name);

      // Check if the type is a struct and has fields
      if (correspondingType.type &&
          correspondingType.type.kind === 'struct' &&
          Array.isArray(correspondingType.type.fields)) {
        
        // Assign the fields to the event object
        event.fields = correspondingType.type.fields;
      }
    }
  }

  // Return the modified object (though it's modified in place)
  return idl_object;
}

// --- Main Function ---
async function main() {
  console.log("🚀 Starting listener with DYNAMIC manual parser...");

  // 1. Load the broken IDL
  console.log(`📂 Loading broken IDL from: ${IDL_PATH}`);
  let idl;
  try {
    const idlContent = fs.readFileSync(IDL_PATH, "utf8");
    idl = JSON.parse(idlContent);
  } catch (e) {
    console.error(`❌ Failed to load IDL: ${e.message}`);
    process.exit(1);
  }

  idl = modify_idl(idl);

  // 2. Extract Event Info from the BROKEN IDL (no hardcoding)
  console.log("🔧 Dynamically building parser from broken IDL...");
  
  // Find discriminator from 'events'
  const eventInfo = idl.events.find(e => e.name === "RequestCreated");
  if (!eventInfo) {
    console.error("❌ Cannot find 'RequestCreated' in IDL 'events' array.");
    process.exit(1);
  }
  const discriminator = Buffer.from(eventInfo.discriminator);

  // Find event fields from 'types'
  const eventType = idl.types.find(t => t.name === "RequestCreated");
  if (!eventType) {
    console.error("❌ Cannot find 'RequestCreated' in IDL 'types' array.");
    process.exit(1);
  }
  const eventFields = eventType.type.fields;

  // Find Message struct fields from 'types'
  const messageType = idl.types.find(t => t.name === "Message");
  if (!messageType) {
    console.error("❌ Cannot find 'Message' in IDL 'types' array.");
    process.exit(1);
  }
  const messageFields = messageType.type.fields;

  // 3. Create Connection
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const programId = new PublicKey(COOLROUTER_PROGRAM_ID);

  // 4. Start Listening
  console.log("🎧 Starting CoolRouter event listener...");
  console.log(`📡 Program ID: ${programId.toString()}`);
  console.log(`🔗 RPC Endpoint: ${connection.rpcEndpoint}\n`);

  const subscriptionId = connection.onLogs(
    programId,
    (logs, ctx) => {
      handleLogs(logs, ctx.slot, discriminator, eventFields, messageFields);
    },
    "confirmed"
  );

  console.log("✅ Event listener started successfully!");
  console.log("Waiting for events...\n");

  process.on("SIGINT", () => {
    console.log("\n🛑 Stopping event listener...");
    connection.removeOnLogsListener(subscriptionId);
    console.log("✅ Event listener stopped.");
    process.exit(0);
  });
}

/**
 * Handles incoming logs from the subscription
 */
function handleLogs(logs, slot, discriminator, eventFields, messageFields) {
  if (logs.err) return;

  for (const log of logs.logs) {
    if (!log.startsWith("Program data: ")) continue;

    const eventDataB64 = log.substring(14);
    const eventDataBuffer = Buffer.from(eventDataB64, "base64");
    if (eventDataBuffer.length < 8) continue;

    const eventDiscriminator = eventDataBuffer.subarray(0, 8);

    if (eventDiscriminator.equals(discriminator)) {
      console.log(`\n[DEBUG] Received logs for signature: ${logs.signature}`);
      console.log(`[DEBUG] Found event data (base64): ${eventDataB64}`);
      console.log("[DEBUG] Matched 'RequestCreated' discriminator.");

      try {
        const payload = eventDataBuffer.subarray(8);
        
        // 6. Dynamically deserialize the payload
        const parser = new BorshBufferParser(payload);
        const event = {};

        // Loop through the fields we found in the IDL and parse them
        for (const field of eventFields) {
          if (field.type === "string") {
            event[field.name] = parser.readString();
          } else if (field.type === "pubkey") {
            event[field.name] = parser.readPubkey();
          } else if (field.type.vec?.defined?.name === "Message") {
            event[field.name] = parser.readStructVec(messageFields);
          }
        }

        handleRequestCreated(event, slot, logs.signature);
      } catch (e) {
        console.error("❌ [PARSE ERROR] Failed to manually deserialize event:");
        console.error(e);
      }
    }
  }
}

/**
 * Handle RequestCreated event
 */
function handleRequestCreated(event, slot, signature) {
  console.log("\n🆕 REQUEST CREATED EVENT");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`Request ID: ${event.request_id}`);
  console.log(`Caller Program: ${event.caller_program.toString()}`);
  console.log(`Provider: ${event.provider}`);
  console.log(`Model ID: ${event.model_id}`);
  console.log(`Slot: ${slot}`);
  console.log(`Signature: ${signature}`);
  console.log(`\nMessages (${event.messages.length}):`);
  event.messages.forEach((msg, idx) => {
    const content = msg.content || "(no content)";
    console.log(
      `  [${idx}] ${msg.role}: ${content.substring(0, 100)}${
        content.length > 100 ? "..." : ""
      }`
    );
  });
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

// Run the main function
main().catch((error) => {
  console.error("❌ Fatal Error:", error);
  process.exit(1);
});