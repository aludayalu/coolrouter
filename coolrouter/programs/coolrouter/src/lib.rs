use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};
use solana_program::hash::hash;

declare_id!("CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu");

#[program]
pub mod coolrouter {
    use super::*;

    pub fn create_request<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateRequest<'info>>,
        request_id: String,
        provider: String,
        model_id: String,
        messages: Vec<Message>,
    ) -> Result<()> {
        let request = &mut ctx.accounts.request;
        let clock = Clock::get()?;
        
        require!(provider.len() <= 64, ErrorCode::ProviderTooLong);
        require!(model_id.len() <= 64, ErrorCode::ModelIdTooLong);
        require!(messages.len() <= 50, ErrorCode::TooManyMessages);
        require!(
            ctx.remaining_accounts.len() <= 64,
            ErrorCode::TooManyAccounts
        );
        
        let callback_program = *ctx.accounts.caller_program.key;
        
        let mut callback_accounts = Vec::new();
        let mut callback_writable = Vec::new();
        
        for account in ctx.remaining_accounts {
            callback_accounts.push(*account.key);
            callback_writable.push(account.is_writable);
        }
        
        request.id = request_id.clone();
        request.caller_program = callback_program;
        request.provider = provider.clone();
        request.model_id = model_id.clone();
        request.callback_accounts = callback_accounts;
        request.callback_writable = callback_writable;
        request.status = RequestStatus::Pending;
        request.created_at = clock.unix_timestamp;
        
        emit!(RequestCreated {
            request_id: request_id.clone(),
            caller_program: callback_program,
            provider: provider,
            model_id: model_id,
            messages: messages,
        });
        
        msg!("Request created: {}", request_id);
        
        Ok(())
    }

    pub fn fulfill_request<'info>(
        ctx: Context<'_, '_, '_, 'info, FulfillRequest<'info>>,
        response: Vec<u8>,
    ) -> Result<()> {
        let request = &mut ctx.accounts.request;
        
        require!(
            request.status == RequestStatus::Pending,
            ErrorCode::NotPending
        );
        
        require!(
            ctx.accounts.callback_program.key() == request.caller_program,
            ErrorCode::CallbackProgramMismatch
        );
        
        require!(
            ctx.remaining_accounts.len() == request.callback_accounts.len(),
            ErrorCode::AccountCountMismatch
        );
        
        for (i, expected_key) in request.callback_accounts.iter().enumerate() {
            require!(
                ctx.remaining_accounts[i].key() == *expected_key,
                ErrorCode::AccountMismatch
            );
        }
        
        let discriminator: [u8; 8] = hash(b"global:llm_callback")
            .to_bytes()[..8]
            .try_into()
            .unwrap();
        
        let mut callback_data: Vec<u8> = discriminator.to_vec();
        callback_data.extend_from_slice(&(request.id.clone(), response.clone()).try_to_vec()?);
        
        let mut account_metas = vec![];
        for (i, pubkey) in request.callback_accounts.iter().enumerate() {
            account_metas.push(AccountMeta {
                pubkey: *pubkey,
                is_signer: false,
                is_writable: request.callback_writable[i],
            });
        }
        
        let ix = Instruction {
            program_id: request.caller_program,
            accounts: account_metas,
            data: callback_data,
        };
        
        invoke(
            &ix,
            ctx.remaining_accounts,
        )?;
        
        request.status = RequestStatus::Fulfilled;
        
        emit!(RequestFulfilled {
            request_id: request.id.clone(),
            response_length: response.len() as u64,
        });
        
        msg!("Request fulfilled: {}", request.id);
        
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(request_id: String)]
pub struct CreateRequest<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 64 + 32 + 64 + 64 + (4 + 32 * 10) + (4 + 1 * 10) + 1 + 8,
        seeds = [b"request", request_id.as_bytes()],
        bump
    )]
    pub request: Account<'info, LLMRequest>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: The calling program
    pub caller_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FulfillRequest<'info> {
    #[account(mut)]
    pub request: Account<'info, LLMRequest>,
    #[account(mut)]
    pub oracle: Signer<'info>,
    /// CHECK: Validated against request.caller_program
    pub callback_program: AccountInfo<'info>,
}

#[account]
pub struct LLMRequest {
    pub id: String,
    pub caller_program: Pubkey,
    pub provider: String,
    pub model_id: String,
    pub callback_accounts: Vec<Pubkey>,
    pub callback_writable: Vec<bool>,
    pub status: RequestStatus,
    pub created_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RequestStatus {
    Pending,
    Fulfilled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[event]
pub struct RequestCreated {
    pub request_id: String,
    pub caller_program: Pubkey,
    pub provider: String,
    pub model_id: String,
    pub messages: Vec<Message>,
}

#[event]
pub struct RequestFulfilled {
    pub request_id: String,
    pub response_length: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Too many callback accounts (max 64)")]
    TooManyAccounts,
    #[msg("Account mismatch in remaining accounts")]
    AccountMismatch,
    #[msg("Request is not pending")]
    NotPending,
    #[msg("Callback program does not match")]
    CallbackProgramMismatch,
    #[msg("Account count mismatch")]
    AccountCountMismatch,
    #[msg("Provider exceeds 64 characters")]
    ProviderTooLong,
    #[msg("Model ID exceeds 64 characters")]
    ModelIdTooLong,
    #[msg("Too many messages (max 50)")]
    TooManyMessages,
}