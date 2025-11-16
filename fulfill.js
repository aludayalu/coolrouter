import { BorshCoder } from "@coral-xyz/anchor";
import { 
  Connection, 
  PublicKey, 
  Keypair, 
  Transaction,
  TransactionInstruction
} from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COOLROUTER_IDL_PATH = path.join(__dirname, "coolrouter/target/idl/coolrouter.json");
const COOLROUTER_PROGRAM_ID = "CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu"; // New address
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "http://localhost:8899";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH || path.join(process.env.HOME, ".config/solana/id.json");

function loadKeypair(filepath) {
  const keypairData = JSON.parse(fs.readFileSync(filepath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(keypairData));
}

async function fulfill(requestId) {
  const idl = JSON.parse(fs.readFileSync(COOLROUTER_IDL_PATH, "utf8"));
  const oracleKeypair = loadKeypair(KEYPAIR_PATH);
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const coolrouterProgramId = new PublicKey(COOLROUTER_PROGRAM_ID);
  const coder = new BorshCoder(idl);

  const [requestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("request"), Buffer.from(requestId)],
    coolrouterProgramId
  );

  const accountInfo = await connection.getAccountInfo(requestPda);
  if (!accountInfo) {
    console.error("Request account not found");
    process.exit(1);
  }
  
  const requestAccount = coder.accounts.decode("LLMRequest", accountInfo.data);

  if (Object.keys(requestAccount.status)[0] !== "Pending") {
    console.log("Request already fulfilled");
    process.exit(0);
  }
  
  const llmResponse = Buffer.from(`This is the oracle's response. The meaning of life is 42. Request ID: ${requestId}`);
  
  const instructionDef = idl.instructions.find(ix => ix.name === "fulfill_request");
  const discriminator = Buffer.from(instructionDef.discriminator);
  
  const instructionData = Buffer.concat([
    discriminator,
    Buffer.from(new Uint8Array(new Uint32Array([llmResponse.length]).buffer)),
    llmResponse,
  ]);

  const keys = [
    { pubkey: requestPda, isSigner: false, isWritable: true },
    { pubkey: oracleKeypair.publicKey, isSigner: true, isWritable: true },
    { pubkey: requestAccount.caller_program, isSigner: false, isWritable: false },
  ];
  
  const remainingAccounts = requestAccount.callback_accounts.map((pubkey, i) => ({
    pubkey: pubkey,
    isSigner: false,
    isWritable: requestAccount.callback_writable[i],
  }));
  
  keys.push(...remainingAccounts);

  const instruction = new TransactionInstruction({
    programId: coolrouterProgramId,
    keys,
    data: instructionData,
  });

  const transaction = new Transaction().add(instruction);
  transaction.feePayer = oracleKeypair.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const signature = await connection.sendTransaction(transaction, [oracleKeypair], {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });

  await connection.confirmTransaction(signature, "confirmed");
  console.log(`Fulfilled: ${requestId}`);
  console.log(`Signature: ${signature}`);
}

const requestId = process.argv[2];
if (!requestId) {
  console.error("Usage: node fulfill.js <request_id>");
  process.exit(1);
}

fulfill(requestId).catch(console.error);