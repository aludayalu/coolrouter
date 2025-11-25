# CoolRouter

CoolRouter is a Solana-based decentralized oracle router designed to facilitate on-chain Large Language Model (LLM) requests. It allows consumer programs to submit prompts, which are then processed by off-chain oracles that vote on the response before fulfilling the request on-chain.

## Architecture

The system consists of the following components:

1.  **Consumer Program (`llm_consumer`)**: An example Solana program that requests LLM responses.
2.  **CoolRouter Program (`coolrouter`)**: The core router that manages requests, oracle votes, and fulfillment.
3.  **Off-chain Oracles**: Scripts that listen for requests, fetch LLM responses (e.g., from OpenAI), and submit votes.

### Flow
1.  **Request**: A consumer program calls `coolrouter` to create a request with a prompt.
2.  **Listen**: Off-chain oracles detect the `RequestCreated` event.
3.  **Process**: Oracles fetch the response from an LLM provider.
4.  **Vote**: Oracles submit a hash of the response to `coolrouter`.
5.  **Consensus**: Once enough votes match (consensus reached), the request is marked `VotingCompleted`.
6.  **Fulfill**: An oracle reveals the actual response. `coolrouter` verifies the hash and calls back the consumer program with the data.

## Prerequisites

*   [Rust](https://www.rust-lang.org/tools/install)
*   [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools)
*   [Anchor](https://www.anchor-lang.com/docs/installation)
*   [Node.js](https://nodejs.org/) / [Bun](https://bun.sh/)

## Setup

1.  **Install Dependencies**:
    ```bash
    cd coolrouter
    npm install
    ```

2.  **Build Programs**:
    ```bash
    anchor build
    ```

3.  **Run Tests**:
    ```bash
    anchor test
    ```

4.  **Run Local Validator**:
    ```bash
    solana-test-validator
    ```

## Project Structure

*   `coolrouter/programs/coolrouter`: The main router program.
*   `coolrouter/programs/llm_consumer`: An example consumer program.
*   `coolrouter/tests`: Integration tests.
*   `fulfill.js`, `invoke.js`, `listen.js`: Off-chain oracle scripts.
