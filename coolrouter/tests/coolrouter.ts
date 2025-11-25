import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Coolrouter } from "../target/types/coolrouter";
import { LlmConsumer } from "../target/types/llm_consumer";
import { createHash } from "crypto";
import { assert } from "chai";

describe("coolrouter", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const coolrouterProgram = anchor.workspace.coolrouter as Program<Coolrouter>;
  const consumerProgram = anchor.workspace.llm_consumer as Program<LlmConsumer>;

  const requestId = "test-request-123";
  const prompt = "What is the capital of France?";
  const response = "Paris";

  // Derive PDAs
  const getRequestPda = (reqId: string) => {
    const hash = createHash("sha256").update(reqId).digest();
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("request"), hash],
      coolrouterProgram.programId
    )[0];
  };

  const getConsumerStatePda = (reqId: string, authority: anchor.web3.PublicKey) => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("consumer_state"), authority.toBuffer(), Buffer.from(reqId)],
      consumerProgram.programId
    )[0];
  };

  it("Full Flow: Request -> Vote -> Fulfill", async () => {
    const requestPda = getRequestPda(requestId);
    const consumerStatePda = getConsumerStatePda(requestId, provider.wallet.publicKey);

    console.log("Request PDA:", requestPda.toBase58());
    console.log("Consumer State PDA:", consumerStatePda.toBase58());

    // 1. Create Request (via Consumer)
    try {
      await consumerProgram.methods
        .requestLlmResponse(requestId, prompt, 1, 100)
        .accounts({
          // consumerState: consumerStatePda,
          authority: provider.wallet.publicKey,
          requestPda: requestPda,
          consumerProgram: consumerProgram.programId,
          coolrouterProgram: coolrouterProgram.programId,
          // systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      console.log("Request created successfully");
    } catch (e) {
      console.error("Error creating request:", e);
      throw e;
    }

    // Verify request state
    const requestAccount = await coolrouterProgram.account.llmRequest.fetch(requestPda);
    assert.equal(requestAccount.id, requestId);
    assert.equal(requestAccount.status.pending !== undefined, true);

    // 2. Submit Vote (Oracle)
    const responseHash = createHash("sha256").update(response).digest();
    const responseHashArray = Array.from(responseHash);

    try {
      await coolrouterProgram.methods
        .submitVote(responseHashArray)
        .accounts({
          request: requestPda,
          oracle: provider.wallet.publicKey,
        })
        .rpc();
      console.log("Vote submitted successfully");
    } catch (e) {
      console.error("Error submitting vote:", e);
      throw e;
    }

    // Verify voting completed
    const requestAccountAfterVote = await coolrouterProgram.account.llmRequest.fetch(requestPda);
    assert.equal(requestAccountAfterVote.status.votingCompleted !== undefined, true);
    assert.deepEqual(requestAccountAfterVote.winningHash, responseHashArray);

    // 3. Fulfill Request
    try {
      await coolrouterProgram.methods
        .fulfillRequest(Buffer.from(response))
        .accounts({
          request: requestPda,
          oracle: provider.wallet.publicKey,
          callbackProgram: consumerProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: consumerStatePda,
            isWritable: true,
            isSigner: false,
          },
        ])
        .rpc();
      console.log("Request fulfilled successfully");
    } catch (e) {
      console.error("Error fulfilling request:", e);
      throw e;
    }

    // Verify fulfilled state
    const requestAccountAfterFulfill = await coolrouterProgram.account.llmRequest.fetch(requestPda);
    assert.equal(requestAccountAfterFulfill.status.fulfilled !== undefined, true);

    // Verify consumer state updated
    const consumerState = await consumerProgram.account.consumerState.fetch(consumerStatePda);
    assert.equal(consumerState.hasResponse, true);
    assert.equal(consumerState.response.toString(), Buffer.from(response).toString());
    console.log("Consumer received response:", consumerState.response.toString());
  });
});
