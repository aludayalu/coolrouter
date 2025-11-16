import { BorshCoder } from "@coral-xyz/anchor";
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

const COOLROUTER_PROGRAM_ID = "CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu";
const TESTER_PROGRAM_ID = "BrRX5CdLjXZDPzaQFY1BnjdsLeqMED1JeKKSjpnaxU1R";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";
const TESTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/llm_consumer.json");
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");

function loadKeypair(filepath) {
  const keypairData = JSON.parse(fs.readFileSync(filepath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

function decodeResponse(responseBytes) {
  try {
    return Buffer.from(responseBytes).toString('utf8');
  } catch {
    return `[Binary data: ${responseBytes.length} bytes]`;
  }
}

async function main() {
  const idl = JSON.parse(fs.readFileSync(TESTER_IDL_PATH, "utf8"));
  const payer = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coder = new BorshCoder(idl);

  const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const prompt = "What is the meaning of life?";
  const minVotes = 1;
  const approvalThreshold = 66;

  const testerProgramId = new PublicKey(TESTER_PROGRAM_ID);
  const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);

  const [consumerStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("consumer_state"), payer.publicKey.toBuffer(), Buffer.from(requestId)],
    testerProgramId
  );

  const [requestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("request"), Buffer.from(requestId)],
    coolrouterProgramId
  );

  const instructionDef = idl.instructions.find(ix => ix.name === "request_llm_response");
  const discriminator = Buffer.from(instructionDef.discriminator);

  const requestIdBuffer = Buffer.from(requestId);
  const promptBuffer = Buffer.from(prompt);
  
  const instructionData = Buffer.concat([
    discriminator,
    Buffer.from(new Uint8Array(new Uint32Array([requestIdBuffer.length]).buffer)),
    requestIdBuffer,
    Buffer.from(new Uint8Array(new Uint32Array([promptBuffer.length]).buffer)),
    promptBuffer,
    Buffer.from([minVotes]),
    Buffer.from([approvalThreshold]),
  ]);

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

  const signature = await connection.sendTransaction(transaction, [payer], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(signature, "confirmed");
  console.log(`Request created: ${requestId}`);
  console.log(`Min votes: ${minVotes}, Approval threshold: ${approvalThreshold}%`);
  console.log(`Signature: ${signature}`);
}

async function queryResponse(requestId) {
  const idl = JSON.parse(fs.readFileSync(TESTER_IDL_PATH, "utf8"));
  const payer = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coder = new BorshCoder(idl);

  const testerProgramId = new PublicKey(TESTER_PROGRAM_ID);

  const [consumerStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("consumer_state"), payer.publicKey.toBuffer(), Buffer.from(requestId)],
    testerProgramId
  );

  const accountInfo = await connection.getAccountInfo(consumerStatePda);
  if (!accountInfo) {
    console.error("Account not found");
    process.exit(1);
  }

  const consumerState = coder.accounts.decode("ConsumerState", accountInfo.data);
  
  console.log(`Request ID: ${consumerState.requestId}`);
  console.log(`Has Response: ${consumerState.hasResponse}`);
  if (consumerState.hasResponse) {
    console.log(`Response: ${decodeResponse(consumerState.response)}`);
  }
}

const args = process.argv.slice(2);
if (args[0] === "query" && args[1]) {
  queryResponse(args[1]).catch(console.error);
} else {
  main().catch(console.error);
}