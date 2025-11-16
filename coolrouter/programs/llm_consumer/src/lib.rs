use anchor_lang::prelude::*;
use coolrouter_cpi::{create_llm_request, Message};

declare_id!("BrRX5CdLjXZDPzaQFY1BnjdsLeqMED1JeKKSjpnaxU1R");

const MAX_REQUEST_ID_LEN: usize = 60;
const MAX_RESPONSE_LEN: usize = 2000;

const ACCOUNT_SPACE: usize = 8
    + (4 + MAX_REQUEST_ID_LEN)
    + (4 + MAX_RESPONSE_LEN)
    + 1
    + 32;

#[program]
pub mod llm_consumer {
    use super::*;

    pub fn request_llm_response(
        ctx: Context<RequestLLMResponse>,
        request_id: String,
        prompt: String,
        min_votes: u8,
        approval_threshold: u8,
    ) -> Result<()> {
        let consumer_state = &mut ctx.accounts.consumer_state;
        
        require!(
            request_id.len() <= MAX_REQUEST_ID_LEN,
            ErrorCode::RequestIdTooLong
        );
        
        require!(min_votes > 0, ErrorCode::InvalidMinVotes);
        require!(
            approval_threshold > 0 && approval_threshold <= 100,
            ErrorCode::InvalidApprovalThreshold
        );
        
        consumer_state.request_id = request_id.clone();
        consumer_state.response = Vec::new();
        consumer_state.has_response = false;
        consumer_state.authority = ctx.accounts.authority.key();
        
        let messages = vec![Message {
            role: "user".to_string(),
            content: prompt,
        }];
        
        let callback_accounts = vec![
            ctx.accounts.consumer_state.to_account_info(),
        ];
        
        create_llm_request(
            ctx.accounts.request_pda.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.consumer_program.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
            ctx.accounts.coolrouter_program.key(),
            callback_accounts,
            request_id.clone(),
            "openai".to_string(),
            "gpt-4".to_string(),
            messages,
            min_votes,
            approval_threshold,
        )?;
        
        msg!("LLM request created with ID: {}", request_id);
        
        Ok(())
    }

    pub fn llm_callback(
        ctx: Context<LLMCallback>,
        request_id: String,
        response: Vec<u8>,
    ) -> Result<()> {
        let consumer_state = &mut ctx.accounts.consumer_state;
        
        require!(
            consumer_state.request_id == request_id,
            ErrorCode::RequestIdMismatch
        );
        
        require!(
            response.len() <= MAX_RESPONSE_LEN,
            ErrorCode::ResponseTooLarge
        );
        
        consumer_state.response = response.clone();
        consumer_state.has_response = true;
        
        let response_preview = String::from_utf8(response.clone())
            .unwrap_or_else(|_| format!("[Binary data: {} bytes]", response.len()))
            .chars()
            .take(100)
            .collect();
        
        emit!(ResponseReceived {
            request_id,
            response_preview,
        });
        
        msg!("LLM response received and stored");
        
        Ok(())
    }

    pub fn get_response(ctx: Context<GetResponse>) -> Result<Vec<u8>> {
        let consumer_state = &ctx.accounts.consumer_state;
        
        require_keys_eq!(
            consumer_state.authority,
            ctx.accounts.authority.key(),
            ErrorCode::Unauthorized
        );
        
        require!(consumer_state.has_response, ErrorCode::NoResponse);
        
        Ok(consumer_state.response.clone())
    }
}

#[derive(Accounts)]
#[instruction(request_id: String)]
pub struct RequestLLMResponse<'info> {
    #[account(
        init,
        payer = authority,
        space = ACCOUNT_SPACE,
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
    pub response: Vec<u8>,
    pub has_response: bool,
    pub authority: Pubkey,
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
    #[msg("Request ID exceeds 60 bytes")]
    RequestIdTooLong,
    #[msg("Response exceeds 2000 bytes")]
    ResponseTooLarge,
    #[msg("Unauthorized: caller is not the request authority")]
    Unauthorized,
    #[msg("Minimum votes must be greater than 0")]
    InvalidMinVotes,
    #[msg("Approval threshold must be between 1 and 100")]
    InvalidApprovalThreshold,
}