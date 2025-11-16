# coolrouter-cpi

A Rust client library for Cross-Program Invocation (CPI) calls to CoolRouter on Solana.

## Overview

CoolRouter is a Solana program that routes LLM inference requests. This crate provides a clean, type-safe interface for making CPI calls to CoolRouter from your Anchor programs.

## Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
coolrouter-cpi = "0.1.0"
```

## Usage

### Simple Request

```rust
use coolrouter_cpi::{create_llm_request, Message};

// In your instruction handler
create_llm_request(
    ctx.accounts.request_pda.to_account_info(),
    ctx.accounts.authority.to_account_info(),
    ctx.accounts.caller_program.to_account_info(),
    ctx.accounts.system_program.to_account_info(),
    ctx.accounts.coolrouter_program.key(),
    vec![ctx.accounts.callback_account.to_account_info()],
    "request_123".to_string(),
    "openai".to_string(),
    "gpt-4".to_string(),
    vec![Message {
        role: "user".to_string(),
        content: "Hello, AI!".to_string(),
    }],
)?;
```

### Builder Pattern

For more control, use the builder:

```rust
use coolrouter_cpi::CoolRouterCPI;

CoolRouterCPI::new(
    request_pda,
    authority,
    caller_program,
    system_program,
    coolrouter_program_id,
)
.add_callback_account(callback_account)
.create_request(
    request_id,
    provider,
    model_id,
    messages,
)?;
```

### Complete Example

```rust
use anchor_lang::prelude::*;
use coolrouter_cpi::{create_llm_request, Message};

#[program]
pub mod my_program {
    use super::*;

    pub fn ask_llm(
        ctx: Context<AskLLM>,
        request_id: String,
        prompt: String,
    ) -> Result<()> {
        // Prepare the message
        let messages = vec![Message {
            role: "user".to_string(),
            content: prompt,
        }];
        
        // Call CoolRouter
        create_llm_request(
            ctx.accounts.request_pda.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.my_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.coolrouter_program.key(),
            vec![ctx.accounts.response_storage.to_account_info()],
            request_id,
            "openai".to_string(),
            "gpt-4".to_string(),
            messages,
        )?;
        
        Ok(())
    }
}

#[derive(Accounts)]
pub struct AskLLM<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: PDA for the request in CoolRouter
    #[account(mut)]
    pub request_pda: AccountInfo<'info>,
    
    /// CHECK: This program's ID
    pub my_program: AccountInfo<'info>,
    
    /// CHECK: The CoolRouter program
    pub coolrouter_program: AccountInfo<'info>,
    
    /// Account where response will be stored
    #[account(mut)]
    pub response_storage: Account<'info, ResponseStorage>,
    
    pub system_program: Program<'info, System>,
}
```

## Features

- **Type-safe**: Uses Anchor types for all accounts and parameters
- **Builder pattern**: Flexible API for complex scenarios
- **Convenience function**: Simple one-liner for common use cases
- **Well-documented**: Comprehensive examples and documentation

## How It Works

1. Your program calls `create_llm_request` with a prompt
2. CoolRouter receives the request and forwards it to the specified LLM provider
3. When the response is ready, CoolRouter calls back to your program
4. Your callback handler receives and processes the response

## Requirements

- Rust 1.70+
- Anchor 0.29.0+
- Solana CLI tools

## License

Licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)
- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)

at your option.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Links

- [crates.io](https://crates.io/crates/coolrouter-cpi)
- [Documentation](https://docs.rs/coolrouter-cpi)
- [Repository](https://github.com/yourusername/coolrouter-cpi)