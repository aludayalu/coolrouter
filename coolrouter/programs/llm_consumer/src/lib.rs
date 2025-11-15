use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use sha2::{Digest, Sha256};

// Replace with actual program ID after deployment
declare_id!("3YZkQzWFLJcTcLQRJpiUy41pjWzw7cWRhqamswiTfqjN");

#[program]
pub mod llm_consumer {
    use super::*;

    /// Initialize a new LLM query
    pub fn request_llm_response(
        ctx: Context<RequestLLMResponse>,
        request_id: String,
        prompt: String,
    ) -> Result<()> {
        let consumer_state = &mut ctx.accounts.consumer_state;
        
        // Get CoolRouter program ID from account
        let coolrouter_program_id = ctx.accounts.coolrouter_program.key();
        
        // Store request info
        consumer_state.request_id = request_id.clone();
        consumer_state.response = String::new();
        consumer_state.has_response = false;
        consumer_state.authority = ctx.accounts.authority.key();
        
        // Prepare the message for the LLM
        let messages = vec![Message {
            role: "user".to_string(),
            content: prompt,
        }];
        
        // Create accounts vec for CPI - include our consumer_state as a callback account
        let accounts_for_callback = vec![
            ctx.accounts.consumer_state.to_account_info(),
        ];
        
        // Build the CPI context
        let cpi_accounts = vec![
            ctx.accounts.request_pda.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.consumer_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ];
        
        // Serialize the instruction data manually
        let mut data = Vec::new();
        
        // Calculate discriminator using SHA256 hash of "global:create_request"
        let mut hasher = Sha256::new();
        hasher.update(b"global:create_request");
        let hash_result = hasher.finalize();
        let discriminator: [u8; 8] = hash_result[..8].try_into().unwrap();
        data.extend_from_slice(&discriminator);
        
        // Serialize parameters
        data.extend_from_slice(&request_id.try_to_vec()?);
        data.extend_from_slice(&"openai".to_string().try_to_vec()?); // provider
        data.extend_from_slice(&"gpt-4".to_string().try_to_vec()?); // model_id
        data.extend_from_slice(&messages.try_to_vec()?);
        
        // Create the instruction
        let mut account_metas = cpi_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect::<Vec<_>>();
        
        // Add remaining accounts (callback accounts)
        for acc in &accounts_for_callback {
            account_metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: false,
                is_writable: true,
            });
        }
        
        let ix = Instruction {
            program_id: coolrouter_program_id.clone(),
            accounts: account_metas,
            data,
        };
        
        // Invoke the CoolRouter
        let mut all_accounts = cpi_accounts;
        all_accounts.extend(accounts_for_callback);
        
        anchor_lang::solana_program::program::invoke(
            &ix,
            &all_accounts,
        )?;
        
        msg!("LLM request created with ID: {}", request_id);
        
        Ok(())
    }

    /// Callback function that CoolRouter will call when the response is ready
    pub fn llm_callback(
        ctx: Context<LLMCallback>,
        request_id: String,
        response: String,
    ) -> Result<()> {
        let consumer_state = &mut ctx.accounts.consumer_state;
        
        require!(
            consumer_state.request_id == request_id,
            ErrorCode::RequestIdMismatch
        );
        
        // Store the response
        consumer_state.response = response.clone();
        consumer_state.has_response = true;
        
        emit!(ResponseReceived {
            request_id,
            response_preview: response.chars().take(100).collect(),
        });
        
        msg!("LLM response received and stored");
        
        Ok(())
    }

    /// Query the stored response
    pub fn get_response(ctx: Context<GetResponse>) -> Result<()> {
        let consumer_state = &ctx.accounts.consumer_state;
        
        require!(consumer_state.has_response, ErrorCode::NoResponse);
        
        msg!("Response: {}", consumer_state.response);
        
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(request_id: String)]
pub struct RequestLLMResponse<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + 64 + 4 + 2000 + 1 + 32,
        seeds = [b"consumer_state", authority.key().as_ref(), request_id.as_bytes()],
        bump
    )]
    pub consumer_state: Account<'info, ConsumerState>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    /// CHECK: PDA for the request in CoolRouter
    #[account(mut)]
    pub request_pda: AccountInfo<'info>,
    
    /// CHECK: This program's ID, passed to CoolRouter as caller_program
    pub consumer_program: AccountInfo<'info>,
    
    /// CHECK: The CoolRouter program
    pub coolrouter_program: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LLMCallback<'info> {
    #[account(mut)]
    pub consumer_state: Account<'info, ConsumerState>,
}

#[derive(Accounts)]
pub struct GetResponse<'info> {
    pub consumer_state: Account<'info, ConsumerState>,
    pub authority: Signer<'info>,
}

#[account]
pub struct ConsumerState {
    pub request_id: String,
    pub response: String,
    pub has_response: bool,
    pub authority: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[event]
pub struct ResponseReceived {
    pub request_id: String,
    pub response_preview: String,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Request ID does not match")]
    RequestIdMismatch,
    #[msg("No response available yet")]
    NoResponse,
}