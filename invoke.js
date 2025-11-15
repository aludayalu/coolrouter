import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Wallet, BorshCoder } from "@coral-xyz/anchor";
import { 
  Connection, 
  PublicKey, 
  Keypair, 
  SystemProgram,
  TransactionInstruction,
  Transaction
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const TESTER_PROGRAM_ID = "3YZkQzWFLJcTcLQRJpiUy41pjWzw7cWRhqamswiTfqjN";
const COOLROUTER_PROGRAM_ID = "DwPxc47Ss4Tyt3q8oT1pu58od2KjB5ZpSihQM3432Dqm";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";
const TESTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/llm_consumer.json");
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");

/**
 * Load keypair from file
 */
function loadKeypair(filepath) {
  const keypairData = JSON.parse(fs.readFileSync(filepath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

/**
 * Main function
 */
async function main() {
  console.log("🚀 Invoking Tester Contract");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Load IDL
  console.log(`📂 Loading Tester IDL from: ${TESTER_IDL_PATH}`);
  if (!fs.existsSync(TESTER_IDL_PATH)) {
    console.error(`❌ IDL file not found at ${TESTER_IDL_PATH}`);
    console.error("   Make sure you have run 'anchor build' first");
    process.exit(1);
  }

  const idlContent = fs.readFileSync(TESTER_IDL_PATH, "utf8");
  const idl = JSON.parse(idlContent);
  console.log(`✅ IDL loaded successfully\n`);

  // Load wallet
  console.log(`🔑 Loading wallet from: ${KEYPAIR_PATH}`);
  const payer = loadKeypair(KEYPAIR_PATH);
  console.log(`   Wallet address: ${payer.publicKey.toString()}\n`);

  // Create connection
  const connection = new Connection(RPC_ENDPOINT, "confirmed");

  // Check balance
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`💰 Wallet balance: ${balance / 1e9} SOL`);
  if (balance === 0) {
    console.error("❌ Insufficient balance. Please airdrop some SOL:");
    console.error(`   solana airdrop 2 ${payer.publicKey.toString()} --url devnet`);
    process.exit(1);
  }
  console.log();

  // Create coder for encoding instruction data
  const coder = new BorshCoder(idl);

  // Generate a unique request ID
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const prompt = "What is the meaning of life?";

  console.log(`📝 Request Details:`);
  console.log(`   Request ID: ${requestId}`);
  console.log(`   Prompt: ${prompt}\n`);

  // Derive PDAs
  const testerProgramId = new PublicKey(TESTER_PROGRAM_ID);
  const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);

  const [consumerStatePda, consumerBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("consumer_state"),
      payer.publicKey.toBuffer(),
      Buffer.from(requestId)
    ],
    testerProgramId
  );

  const [requestPda, requestBump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("request"),
      Buffer.from(requestId)
    ],
    coolrouterProgramId
  );

  console.log(`🔍 Derived Accounts:`);
  console.log(`   Consumer State PDA: ${consumerStatePda.toString()}`);
  console.log(`   CoolRouter Request PDA: ${requestPda.toString()}\n`);

  try {
    console.log("📤 Building transaction...");

    // Get the instruction discriminator from IDL
    const instructionDef = idl.instructions.find(ix => ix.name === "request_llm_response");
    const discriminator = Buffer.from(instructionDef.discriminator);

    // Manually encode the arguments
    const requestIdBuffer = Buffer.from(requestId);
    const promptBuffer = Buffer.from(prompt);
    
    // Create instruction data: discriminator + request_id length + request_id + prompt length + prompt
    const instructionData = Buffer.concat([
      discriminator,
      // Encode request_id (4 bytes length + data)
      Buffer.from(new Uint8Array(new Uint32Array([requestIdBuffer.length]).buffer)),
      requestIdBuffer,
      // Encode prompt (4 bytes length + data)
      Buffer.from(new Uint8Array(new Uint32Array([promptBuffer.length]).buffer)),
      promptBuffer,
    ]);

    // Build accounts for the instruction
    const keys = [
      { pubkey: consumerStatePda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: testerProgramId, isSigner: false, isWritable: false },
      { pubkey: coolrouterProgramId, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    const instruction = new TransactionInstruction({
      programId: testerProgramId,
      keys,
      data: instructionData,
    });

    const transaction = new Transaction().add(instruction);
    transaction.feePayer = payer.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log("📤 Sending transaction...");
    const signature = await connection.sendTransaction(transaction, [payer], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });

    console.log(`   Signature: ${signature}`);
    console.log("   Confirming...");

    await connection.confirmTransaction(signature, "confirmed");

    console.log(`✅ Transaction successful!`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet\n`);

    // Wait a bit for the account to be created
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Fetch the consumer state manually
    console.log("📊 Fetching consumer state...");
    const accountInfo = await connection.getAccountInfo(consumerStatePda);
    
    if (accountInfo) {
      const consumerState = coder.accounts.decode("ConsumerState", accountInfo.data);
      
      console.log("\n📋 Consumer State:");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(`Request ID: ${consumerState.requestId}`);
      console.log(`Authority: ${consumerState.authority.toString()}`);
      console.log(`Has Response: ${consumerState.hasResponse}`);
      if (consumerState.hasResponse) {
        console.log(`Response: ${consumerState.response}`);
      } else {
        console.log(`Status: Waiting for oracle to fulfill request...`);
      }
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    } else {
      console.log("❌ Consumer state account not found (may still be processing)\n");
    }

    console.log("💡 Next steps:");
    console.log("   1. The event listener should have picked up the RequestCreated event");
    console.log("   2. An oracle needs to call fulfill_request on CoolRouter");
    console.log("   3. CoolRouter will then call llm_callback on the tester program");
    console.log(`   4. You can query the response later with: node invoke.js query ${requestId}\n`);

  } catch (error) {
    console.error("❌ Transaction failed:", error);
    
    if (error.logs) {
      console.error("\nTransaction logs:");
      error.logs.forEach(log => console.error(`   ${log}`));
    }
    
    process.exit(1);
  }
}

/**
 * Query response function (separate call)
 */
async function queryResponse(requestId) {
  console.log("\n🔍 Querying Response");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const idlContent = fs.readFileSync(TESTER_IDL_PATH, "utf8");
  const idl = JSON.parse(idlContent);

  const payer = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coder = new BorshCoder(idl);

  const testerProgramId = new PublicKey(TESTER_PROGRAM_ID);

  const [consumerStatePda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("consumer_state"),
      payer.publicKey.toBuffer(),
      Buffer.from(requestId)
    ],
    testerProgramId
  );

  console.log(`📍 Consumer State PDA: ${consumerStatePda.toString()}\n`);

  try {
    // Fetch and display the state
    const accountInfo = await connection.getAccountInfo(consumerStatePda);
    
    if (!accountInfo) {
      console.error("❌ Consumer state account not found");
      console.error("   Make sure the request was created successfully\n");
      process.exit(1);
    }

    const consumerState = coder.accounts.decode("ConsumerState", accountInfo.data);
    
    console.log("📋 Consumer State:");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`Request ID: ${consumerState.requestId}`);
    console.log(`Authority: ${consumerState.authority.toString()}`);
    console.log(`Has Response: ${consumerState.hasResponse}`);
    console.log();
    
    if (consumerState.hasResponse) {
      console.log("Response:");
      console.log(consumerState.response);
    } else {
      console.log("⏳ No response available yet - waiting for oracle fulfillment");
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  } catch (error) {
    console.error("❌ Query failed:", error.message);
    process.exit(1);
  }
}

// Check if we're querying an existing request
const args = process.argv.slice(2);
if (args[0] === "query" && args[1]) {
  queryResponse(args[1]).catch(console.error);
} else {
  main().catch((error) => {
    console.error("❌ Error:", error);
    process.exit(1);
  });
}