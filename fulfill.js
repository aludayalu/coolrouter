import * as anchor from "@coral-xyz/anchor";
import { BorshCoder } from "@coral-xyz/anchor";
import { 
  Connection, 
  PublicKey, 
  Keypair, 
  SystemProgram,
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration ---
// Using the exact paths from your listener script
const COOLROUTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");
const COOLROUTER_PROGRAM_ID = "DwPxc47Ss4Tyt3q8oT1pu58od2KjB5ZpSihQM3432Dqm";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");

/**
 * Load keypair from file
 */
function loadKeypair(filepath) {
  const keypairData = JSON.parse(fs.readFileSync(filepath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

/**
 * Main function to fulfill a request
 */
async function fulfill(requestId) {
  if (!requestId) {
    console.error("❌ Error: Missing request_id argument");
    console.error("Usage: node fulfill.js <request_id>");
    process.exit(1);
  }
  
  console.log(`🤖 Fulfilling Request: ${requestId}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Load IDL
  console.log(`📂 Loading CoolRouter IDL from: ${COOLROUTER_IDL_PATH}`);
  if (!fs.existsSync(COOLROUTER_IDL_PATH)) {
    console.error(`❌ IDL file not found at ${COOLROUTER_IDL_PATH}`);
    console.error("   Make sure you have run 'anchor build' and the path is correct.");
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(COOLROUTER_IDL_PATH, "utf8"));
  console.log(`✅ IDL loaded successfully\n`);

  // Load oracle wallet
  console.log(`🔑 Loading oracle wallet from: ${KEYPAIR_PATH}`);
  const oracleKeypair = loadKeypair(KEYPAIR_PATH);
  console.log(`   Oracle address: ${oracleKeypair.publicKey.toString()}\n`);

  // Setup Connection
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);

  // Create coder for encoding instruction data
  const coder = new BorshCoder(idl);

  // --- Start Fulfillment Logic ---

  try {
    // 1. Derive the request PDA
    const [requestPda, requestBump] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("request"),
        Buffer.from(requestId)
      ],
      coolrouterProgramId
    );
    console.log(`🔍 Derived Request PDA: ${requestPda.toString()}`);

    // 2. Fetch the request account info
    console.log("📤 Fetching request state from chain...");
    const accountInfo = await connection.getAccountInfo(requestPda);
    
    if (!accountInfo) {
      console.error("❌ Request account not found on-chain at:", requestPda.toString());
      console.error("   Make sure the request_id is correct and the invoke.js script succeeded.");
      process.exit(1);
    }
    
    // 3. Decode the account data manually
    const requestAccount = coder.accounts.decode("LLMRequest", accountInfo.data);
    
    console.log("✅ Request state fetched and decoded:");
    
    // --- 🛠️ FIX: Using snake_case for all fields ---
    console.log(`   - Caller Program: ${requestAccount.caller_program.toString()}`);
    console.log(`   - Status: ${Object.keys(requestAccount.status)[0]}`);
    console.log(`   - Callback Accounts: ${requestAccount.callback_accounts.length}`);

    // Check if already fulfilled
    if (Object.keys(requestAccount.status)[0] !== "Pending") {
      console.warn("⚠️ Request is not in a 'Pending' state. It may have already been fulfilled.");
      process.exit(0);
    }
    
    // 4. Prepare the response
    const llmResponse = `This is the oracle's response. The meaning of life is 42. Request ID: ${requestId}`;
    console.log(`\n💬 Prepared response: "${llmResponse.substring(0, 50)}..."\n`);
    
    // 5. Get the instruction discriminator from IDL
    const instructionDef = idl.instructions.find(ix => ix.name === "fulfill_request");
    const discriminator = Buffer.from(instructionDef.discriminator);

    // 6. Manually encode the arguments
    const responseBuffer = Buffer.from(llmResponse);
    
    // Create instruction data: discriminator + response length + response
    const instructionData = Buffer.concat([
      discriminator,
      // Encode response (4 bytes length + data)
      Buffer.from(new Uint8Array(new Uint32Array([responseBuffer.length]).buffer)),
      responseBuffer,
    ]);

    // 7. Build accounts for the instruction
    const keys = [
      { pubkey: requestPda, isSigner: false, isWritable: true },
      { pubkey: oracleKeypair.publicKey, isSigner: true, isWritable: true },
      // --- 🛠️ FIX: Using snake_case ---
      { pubkey: requestAccount.caller_program, isSigner: false, isWritable: false },
    ];
    
    // 8. Add the callback accounts as remainingAccounts
    // --- 🛠️ FIX: Using snake_case ---
    const remainingAccounts = requestAccount.callback_accounts.map((pubkey, i) => ({
      pubkey: pubkey,
      isSigner: false,
      isWritable: requestAccount.callback_writable[i],
    }));
    
    // Add the remaining accounts to the main keys list
    keys.push(...remainingAccounts);
    
    console.log(`📋 Building instruction with ${keys.length} total accounts...`);

    // 9. Create the instruction
    const instruction = new TransactionInstruction({
      programId: coolrouterProgramId,
      keys,
      data: instructionData,
    });

    // 10. Build and send the transaction
    const transaction = new Transaction().add(instruction);
    transaction.feePayer = oracleKeypair.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    console.log("🚀 Sending fulfillment transaction...");
    const signature = await connection.sendTransaction(transaction, [oracleKeypair], {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    
    console.log(`   Signature: ${signature}`);
    console.log("   Confirming...");

    await connection.confirmTransaction(signature, "confirmed");

    console.log(`✅ Transaction successful!`);
    console.log(`   Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet\n`);
    
    console.log("💡 The llm_consumer program's 'llm_callback' function should now have been executed.");
    console.log(`   You can run 'node invoke.js query ${requestId}' to see the response stored in the consumer state.`);

  } catch (error) {
    console.error("❌ Fulfillment failed:", error);
    
    if (error.logs) {
      console.error("\nTransaction logs:");
      error.logs.forEach(log => console.error(`   ${log}`));
    }
    
    process.exit(1);
  }
}

// --- Run the script ---
const args = process.argv.slice(2);
const requestId = args[0];

fulfill(requestId).catch((error) => {
  console.error("❌ Unhandled Error:", error);
  process.exit(1);
});