import { BorshCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const COOLROUTER_PROGRAM_ID = "CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu";
const LLM_CONSUMER_PROGRAM_ID = "BrRX5CdLjXZDPzaQFY1BnjdsLeqMED1JeKKSjpnaxU1R";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COOLROUTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");
const CONSUMER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/llm_consumer.json");

class BorshBufferParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.offset = 0;
  }

  readU8() {
    const value = this.buffer.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readU32() {
    const value = this.buffer.readUInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readU64() {
    const low = this.buffer.readUInt32LE(this.offset);
    const high = this.buffer.readUInt32LE(this.offset + 4);
    this.offset += 8;
    return low + high * 0x100000000;
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

  readBytes(length) {
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readStruct(fields) {
    const struct = {};
    for (const field of fields) {
      if (field.type === "string") {
        struct[field.name] = this.readString();
      } else if (field.type === "pubkey") {
        struct[field.name] = this.readPubkey();
      } else if (field.type === "u8") {
        struct[field.name] = this.readU8();
      } else if (field.type.array && field.type.array[0] === "u8" && field.type.array[1] === 32) {
        struct[field.name] = this.readBytes(32);
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

function loadKeypair(filepath) {
  const keypairData = JSON.parse(fs.readFileSync(filepath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

function computeResponseHash(responseText) {
  const responseBuffer = Buffer.from(responseText);
  return createHash("sha256").update(responseBuffer).digest();
}

class OracleNode {
  constructor() {
    this.coolrouterIdl = modify_idl(JSON.parse(fs.readFileSync(COOLROUTER_IDL_PATH, "utf8")));
    this.consumerIdl = modify_idl(JSON.parse(fs.readFileSync(CONSUMER_IDL_PATH, "utf8")));
    this.oracleKeypair = loadKeypair(KEYPAIR_PATH);
    this.connection = new Connection(RPC_ENDPOINT, "confirmed");
    this.coolrouterCoder = new BorshCoder(this.coolrouterIdl);
    this.pendingRequests = new Map();

    this.eventDiscriminators = {
      requestCreated: Buffer.from(this.coolrouterIdl.events.find(e => e.name === "RequestCreated").discriminator),
      votingCompleted: Buffer.from(this.coolrouterIdl.events.find(e => e.name === "VotingCompleted").discriminator),
      requestFulfilled: Buffer.from(this.coolrouterIdl.events.find(e => e.name === "RequestFulfilled").discriminator),
      responseReceived: Buffer.from(this.consumerIdl.events.find(e => e.name === "ResponseReceived").discriminator),
    };

    this.eventFields = {
      requestCreated: this.coolrouterIdl.types.find(t => t.name === "RequestCreated").type.fields,
      votingCompleted: this.coolrouterIdl.types.find(t => t.name === "VotingCompleted").type.fields,
      requestFulfilled: this.coolrouterIdl.types.find(t => t.name === "RequestFulfilled").type.fields,
      responseReceived: this.consumerIdl.types.find(t => t.name === "ResponseReceived").type.fields,
      message: this.coolrouterIdl.types.find(t => t.name === "Message").type.fields,
    };
  }

  async start() {
    const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);
    const consumerProgramId = new PublicKey(LLM_CONSUMER_PROGRAM_ID);

    this.connection.onLogs(
      coolrouterProgramId,
      (logs, ctx) => this.handleCoolrouterLogs(logs, ctx.slot),
      "confirmed"
    );

    this.connection.onLogs(
      consumerProgramId,
      (logs, ctx) => this.handleConsumerLogs(logs, ctx.slot),
      "confirmed"
    );

    console.log(`Oracle node started with pubkey: ${this.oracleKeypair.publicKey.toString()}`);
    console.log("Listening for events...");

    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      process.exit(0);
    });
  }

  handleCoolrouterLogs(logs, slot) {
    if (logs.err) return;

    for (const log of logs.logs) {
      if (!log.startsWith("Program data: ")) continue;

      const eventDataB64 = log.substring(14);
      const eventDataBuffer = Buffer.from(eventDataB64, "base64");
      if (eventDataBuffer.length < 8) continue;

      const eventDiscriminator = eventDataBuffer.subarray(0, 8);

      if (eventDiscriminator.equals(this.eventDiscriminators.requestCreated)) {
        this.handleRequestCreated(eventDataBuffer, slot, logs.signature);
      } else if (eventDiscriminator.equals(this.eventDiscriminators.votingCompleted)) {
        this.handleVotingCompleted(eventDataBuffer, slot, logs.signature);
      } else if (eventDiscriminator.equals(this.eventDiscriminators.requestFulfilled)) {
        this.handleRequestFulfilled(eventDataBuffer, slot, logs.signature);
      }
    }
  }

  handleConsumerLogs(logs, slot) {
    if (logs.err) return;

    for (const log of logs.logs) {
      if (!log.startsWith("Program data: ")) continue;

      const eventDataB64 = log.substring(14);
      const eventDataBuffer = Buffer.from(eventDataB64, "base64");
      if (eventDataBuffer.length < 8) continue;

      const eventDiscriminator = eventDataBuffer.subarray(0, 8);

      if (eventDiscriminator.equals(this.eventDiscriminators.responseReceived)) {
        this.handleResponseReceived(eventDataBuffer, slot, logs.signature);
      }
    }
  }

  handleRequestCreated(eventDataBuffer, slot, signature) {
    try {
      const payload = eventDataBuffer.subarray(8);
      const parser = new BorshBufferParser(payload);
      const event = {};

      for (const field of this.eventFields.requestCreated) {
        if (field.type === "string") {
          event[field.name] = parser.readString();
        } else if (field.type === "pubkey") {
          event[field.name] = parser.readPubkey();
        } else if (field.type === "u8") {
          event[field.name] = parser.readU8();
        } else if (field.type.vec?.defined?.name === "Message") {
          event[field.name] = parser.readStructVec(this.eventFields.message);
        }
      }

      console.log(`\n[RequestCreated] ${event.request_id}`);
      console.log(`  Provider: ${event.provider}, Model: ${event.model_id}`);
      console.log(`  Min Votes: ${event.min_votes}, Threshold: ${event.approval_threshold}%`);
      console.log(`  Slot: ${slot}, Signature: ${signature}`);

      this.pendingRequests.set(event.request_id, {
        caller_program: event.caller_program,
        messages: event.messages,
        min_votes: event.min_votes,
        approval_threshold: event.approval_threshold,
      });

      setImmediate(() => this.submitVote(event.request_id, event.messages));
    } catch (e) {
      console.error("Parse error (RequestCreated):", e);
    }
  }

  handleVotingCompleted(eventDataBuffer, slot, signature) {
    try {
      const payload = eventDataBuffer.subarray(8);
      const parser = new BorshBufferParser(payload);
      const event = {};

      for (const field of this.eventFields.votingCompleted) {
        if (field.type === "string") {
          event[field.name] = parser.readString();
        } else if (field.type.array && field.type.array[0] === "u8" && field.type.array[1] === 32) {
          event[field.name] = parser.readBytes(32);
        } else if (field.type === "u8") {
          event[field.name] = parser.readU8();
        }
      }

      console.log(`\n[VotingCompleted] ${event.request_id}`);
      console.log(`  Winning Hash: ${event.winning_hash.toString('hex')}`);
      console.log(`  Votes: ${event.vote_count}/${event.total_votes}`);
      console.log(`  Slot: ${slot}, Signature: ${signature}`);

      const requestData = this.pendingRequests.get(event.request_id);
      if (requestData) {
        requestData.winning_hash = event.winning_hash;
        requestData.vote_count = event.vote_count;
        requestData.total_votes = event.total_votes;

        setImmediate(() => this.maybeFulfill(event.request_id, requestData));
      }
    } catch (e) {
      console.error("Parse error (VotingCompleted):", e);
    }
  }

  handleRequestFulfilled(eventDataBuffer, slot, signature) {
    try {
      const payload = eventDataBuffer.subarray(8);
      const parser = new BorshBufferParser(payload);
      const event = {};

      for (const field of this.eventFields.requestFulfilled) {
        if (field.type === "string") {
          event[field.name] = parser.readString();
        } else if (field.type === "u64") {
          event[field.name] = Number(parser.readU64());
        }
      }

      console.log(`\n[RequestFulfilled] ${event.request_id}`);
      console.log(`  Response Length: ${event.response_length} bytes`);
      console.log(`  Slot: ${slot}, Signature: ${signature}`);

      this.pendingRequests.delete(event.request_id);
    } catch (e) {
      console.error("Parse error (RequestFulfilled):", e);
    }
  }

  handleResponseReceived(eventDataBuffer, slot, signature) {
    try {
      const payload = eventDataBuffer.subarray(8);
      const parser = new BorshBufferParser(payload);
      const event = {};

      for (const field of this.eventFields.responseReceived) {
        if (field.type === "string") {
          event[field.name] = parser.readString();
        }
      }

      console.log(`\n[ResponseReceived] ${event.request_id}`);
      console.log(`  Preview: ${event.response_preview}`);
      console.log(`  Slot: ${slot}, Signature: ${signature}`);
    } catch (e) {
      console.error("Parse error (ResponseReceived):", e);
    }
  }

  async submitVote(requestId, messages) {
    try {
      const llmResponse = "Joe Mama Deez Nuts";
      const responseHash = computeResponseHash(llmResponse);

      const requestData = this.pendingRequests.get(requestId);
      if (requestData) {
        requestData.myResponse = llmResponse;
        requestData.myHash = responseHash;
      }

      console.log(`\n[Oracle] Submitting vote for ${requestId}`);
      console.log(`  Response: "${llmResponse}"`);
      console.log(`  Response hash: ${responseHash.toString('hex').substring(0, 16)}...`);

      const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);
      const [requestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("request"), Buffer.from(requestId)],
        coolrouterProgramId
      );

      const instructionDef = this.coolrouterIdl.instructions.find(ix => ix.name === "submit_vote");
      const discriminator = Buffer.from(instructionDef.discriminator);

      const instructionData = Buffer.concat([
        discriminator,
        responseHash,
      ]);

      const keys = [
        { pubkey: requestPda, isSigner: false, isWritable: true },
        { pubkey: this.oracleKeypair.publicKey, isSigner: true, isWritable: false },
      ];

      const instruction = new TransactionInstruction({
        programId: coolrouterProgramId,
        keys,
        data: instructionData,
      });

      const transaction = new Transaction().add(instruction);
      transaction.feePayer = this.oracleKeypair.publicKey;
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await this.connection.sendTransaction(transaction, [this.oracleKeypair], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await this.connection.confirmTransaction(signature, "confirmed");
      console.log(`[Oracle] Vote submitted: ${signature}`);
    } catch (e) {
      console.error(`[Oracle] Failed to submit vote for ${requestId}:`, e.message);
    }
  }

  async maybeFulfill(requestId, requestData) {
    try {
      await new Promise(resolve => setTimeout(resolve, 500));

      if (!requestData.myResponse || !requestData.myHash) {
        console.log(`[Oracle] No response stored for ${requestId}, skipping fulfill`);
        return;
      }

      if (!requestData.winning_hash.equals(requestData.myHash)) {
        console.log(`[Oracle] Our hash didn't win for ${requestId}, skipping fulfill`);
        return;
      }

      const totalVotes = requestData.total_votes;
      const voteCount = requestData.vote_count;
      const maxFulfillers = Math.max(1, Math.min(Math.floor(totalVotes * 0.2), 4));
      const probability = maxFulfillers / totalVotes;

      const random = Math.random();
      console.log(`\n[Oracle] Fulfill probability for ${requestId}: ${(probability * 100).toFixed(2)}%`);
      console.log(`[Oracle] Random: ${(random * 100).toFixed(2)}%, Max fulfillers: ${maxFulfillers}/${totalVotes}`);

      if (random >= probability) {
        console.log(`[Oracle] Not selected to fulfill ${requestId}`);
        return;
      }

      console.log(`[Oracle] Selected to fulfill ${requestId}!`);

      await this.fulfill(requestId, requestData);
    } catch (e) {
      console.error(`[Oracle] Error in maybeFulfill for ${requestId}:`, e.message);
    }
  }

  async fulfill(requestId, requestData) {
    try {
      const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);
      const [requestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("request"), Buffer.from(requestId)],
        coolrouterProgramId
      );

      const accountInfo = await this.connection.getAccountInfo(requestPda);
      if (!accountInfo) {
        console.error(`[Oracle] Request account not found for ${requestId}`);
        return;
      }

      const requestAccount = this.coolrouterCoder.accounts.decode("LLMRequest", accountInfo.data);

      const statusKey = Object.keys(requestAccount.status)[0];
      
      if (statusKey !== "VotingCompleted") {
        console.log(`[Oracle] Request ${requestId} not in VotingCompleted state (current: ${statusKey})`);
        return;
      }

      const callerProgram = requestAccount.callerProgram || requestAccount.caller_program;
      const callbackAccounts = requestAccount.callbackAccounts || requestAccount.callback_accounts || [];
      const callbackWritable = requestAccount.callbackWritable || requestAccount.callback_writable || [];

      if (!callerProgram) {
        console.error(`[Oracle] Cannot find callerProgram field in account`);
        return;
      }

      const llmResponse = Buffer.from(requestData.myResponse);

      const instructionDef = this.coolrouterIdl.instructions.find(ix => ix.name === "fulfill_request");
      const discriminator = Buffer.from(instructionDef.discriminator);

      const instructionData = Buffer.concat([
        discriminator,
        Buffer.from(new Uint8Array(new Uint32Array([llmResponse.length]).buffer)),
        llmResponse,
      ]);

      const keys = [
        { pubkey: requestPda, isSigner: false, isWritable: true },
        { pubkey: this.oracleKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: callerProgram, isSigner: false, isWritable: false },
      ];

      const remainingAccounts = callbackAccounts.map((pubkey, i) => ({
        pubkey: pubkey,
        isSigner: false,
        isWritable: callbackWritable[i],
      }));

      keys.push(...remainingAccounts);

      const instruction = new TransactionInstruction({
        programId: coolrouterProgramId,
        keys,
        data: instructionData,
      });

      const transaction = new Transaction().add(instruction);
      transaction.feePayer = this.oracleKeypair.publicKey;
      transaction.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;

      const signature = await this.connection.sendTransaction(transaction, [this.oracleKeypair], {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await this.connection.confirmTransaction(signature, "confirmed");
      console.log(`[Oracle] Fulfilled ${requestId}: ${signature}`);
    } catch (e) {
      console.error(`[Oracle] Failed to fulfill ${requestId}:`, e.message);
    }
  }

  async callLLM(messages) {
    await new Promise(resolve => setTimeout(resolve, 100));
    return "Joe Mama Deez Nuts";
  }
}

const oracle = new OracleNode();
oracle.start().catch(console.error);