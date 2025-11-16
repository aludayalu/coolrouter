import { Connection, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const COOLROUTER_PROGRAM_ID = "CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu";
const LLM_CONSUMER_PROGRAM_ID = "BrRX5CdLjXZDPzaQFY1BnjdsLeqMED1JeKKSjpnaxU1R";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOLROUTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");
const CONSUMER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/llm_consumer.json");

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
    const strBuffer = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return strBuffer.toString("utf8");
  }

  readPubkey() {
    const pubkeyBuffer = this.buffer.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return new PublicKey(pubkeyBuffer);
  }

  readStruct(fields) {
    const struct = {};
    for (const field of fields) {
      if (field.type === "string") {
        struct[field.name] = this.readString();
      } else if (field.type === "pubkey") {
        struct[field.name] = this.readPubkey();
      }
    }
    return struct;
  }

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
  const typeMap = new Map();
  for (const typeDef of idl_object.types) {
    typeMap.set(typeDef.name, typeDef);
  }

  for (const event of idl_object.events) {
    if (typeMap.has(event.name)) {
      const correspondingType = typeMap.get(event.name);
      if (correspondingType.type?.kind === 'struct' && correspondingType.type.fields) {
        event.fields = correspondingType.type.fields;
      }
    }
  }

  return idl_object;
}

async function main() {
  const coolrouterIdl = modify_idl(JSON.parse(fs.readFileSync(COOLROUTER_IDL_PATH, "utf8")));
  const consumerIdl = modify_idl(JSON.parse(fs.readFileSync(CONSUMER_IDL_PATH, "utf8")));
  
  const requestCreatedInfo = coolrouterIdl.events.find(e => e.name === "RequestCreated");
  const requestCreatedDiscriminator = Buffer.from(requestCreatedInfo.discriminator);

  const requestCreatedType = coolrouterIdl.types.find(t => t.name === "RequestCreated");
  const requestCreatedFields = requestCreatedType.type.fields;

  const messageType = coolrouterIdl.types.find(t => t.name === "Message");
  const messageFields = messageType.type.fields;

  const responseReceivedInfo = consumerIdl.events.find(e => e.name === "ResponseReceived");
  const responseReceivedDiscriminator = Buffer.from(responseReceivedInfo.discriminator);

  const responseReceivedType = consumerIdl.types.find(t => t.name === "ResponseReceived");
  const responseReceivedFields = responseReceivedType.type.fields;

  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);
  const consumerProgramId = new PublicKey(LLM_CONSUMER_PROGRAM_ID);

  connection.onLogs(
    coolrouterProgramId,
    (logs, ctx) => {
      handleCoolrouterLogs(logs, ctx.slot, {
        requestCreated: { discriminator: requestCreatedDiscriminator, fields: requestCreatedFields },
        messageFields
      });
    },
    "confirmed"
  );

  connection.onLogs(
    consumerProgramId,
    (logs, ctx) => {
      handleConsumerLogs(logs, ctx.slot, {
        responseReceived: { discriminator: responseReceivedDiscriminator, fields: responseReceivedFields }
      });
    },
    "confirmed"
  );

  console.log("Listening for events...");

  process.on("SIGINT", () => {
    process.exit(0);
  });
}

function handleCoolrouterLogs(logs, slot, eventData) {
  if (logs.err) return;

  for (const log of logs.logs) {
    if (!log.startsWith("Program data: ")) continue;

    const eventDataB64 = log.substring(14);
    const eventDataBuffer = Buffer.from(eventDataB64, "base64");
    if (eventDataBuffer.length < 8) continue;

    const eventDiscriminator = eventDataBuffer.subarray(0, 8);

    if (eventDiscriminator.equals(eventData.requestCreated.discriminator)) {
      try {
        const payload = eventDataBuffer.subarray(8);
        const parser = new BorshBufferParser(payload);
        const event = {};

        for (const field of eventData.requestCreated.fields) {
          if (field.type === "string") {
            event[field.name] = parser.readString();
          } else if (field.type === "pubkey") {
            event[field.name] = parser.readPubkey();
          } else if (field.type.vec?.defined?.name === "Message") {
            event[field.name] = parser.readStructVec(eventData.messageFields);
          }
        }

        handleRequestCreated(event, slot, logs.signature);
      } catch (e) {
        console.error("Parse error:", e);
      }
    }
  }
}

function handleConsumerLogs(logs, slot, eventData) {
  if (logs.err) return;

  for (const log of logs.logs) {
    if (!log.startsWith("Program data: ")) continue;

    const eventDataB64 = log.substring(14);
    const eventDataBuffer = Buffer.from(eventDataB64, "base64");
    if (eventDataBuffer.length < 8) continue;

    const eventDiscriminator = eventDataBuffer.subarray(0, 8);

    if (eventDiscriminator.equals(eventData.responseReceived.discriminator)) {
      try {
        const payload = eventDataBuffer.subarray(8);
        const parser = new BorshBufferParser(payload);
        const event = {};

        for (const field of eventData.responseReceived.fields) {
          if (field.type === "string") {
            event[field.name] = parser.readString();
          }
        }

        handleResponseReceived(event, slot, logs.signature);
      } catch (e) {
        console.error("Parse error:", e);
      }
    }
  }
}

function handleRequestCreated(event, slot, signature) {
  console.log(`\nRequest ID: ${event.request_id}`);
  console.log(`Caller Program: ${event.caller_program.toString()}`);
  console.log(`Provider: ${event.provider}`);
  console.log(`Model ID: ${event.model_id}`);
  console.log(`Slot: ${slot}`);
  console.log(`Signature: ${signature}`);
  console.log(`Messages: ${event.messages.length}`);
  event.messages.forEach((msg, idx) => {
    console.log(`  [${idx}] ${msg.role}: ${msg.content.substring(0, 100)}`);
  });
}

function handleResponseReceived(event, slot, signature) {
  console.log(`\nResponse Received: ${event.request_id}`);
  console.log(`Preview: ${event.response_preview}`);
  console.log(`Slot: ${slot}`);
  console.log(`Signature: ${signature}`);
}

main().catch(console.error);