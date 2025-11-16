use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke};
use solana_program::hash::hash;

declare_id!("CATsZNcHms98EcQo1qzGcA3XLPf47NLhQC5g2cRe19Gu");

const MAX_CALLBACK_ACCOUNTS: usize = 32;
const MAX_ORACLES: usize = 32;

#[program]
pub mod coolrouter {
    use super::*;

    pub fn create_request<'info>(
        ctx: Context<'_, '_, '_, 'info, CreateRequest<'info>>,
        request_id: String,
        provider: String,
        model_id: String,
        messages: Vec<Message>,
        min_votes: u8,
        approval_threshold: u8,
    ) -> Result<()> {
        let request = &mut ctx.accounts.request;
        let clock = Clock::get()?;
        
        require!(provider.len() <= 64, ErrorCode::ProviderTooLong);
        require!(model_id.len() <= 64, ErrorCode::ModelIdTooLong);
        require!(messages.len() <= 50, ErrorCode::TooManyMessages);
        require!(
            ctx.remaining_accounts.len() <= MAX_CALLBACK_ACCOUNTS,
            ErrorCode::TooManyAccounts
        );
        require!(min_votes > 0, ErrorCode::InvalidMinVotes);
        require!(
            approval_threshold > 0 && approval_threshold <= 100,
            ErrorCode::InvalidApprovalThreshold
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
        request.min_votes = min_votes;
        request.approval_threshold = approval_threshold;
        request.votes = Vec::new();
        request.winning_hash = None;
        request.total_votes_cast = 0;
        
        emit!(RequestCreated {
            request_id: request_id.clone(),
            caller_program: callback_program,
            provider: provider,
            model_id: model_id,
            messages: messages,
            min_votes: min_votes,
            approval_threshold: approval_threshold,
        });
        
        msg!("Request created: {}", request_id);
        
        Ok(())
    }

    pub fn submit_vote(
        ctx: Context<SubmitVote>,
        response_hash: [u8; 32],
    ) -> Result<()> {
        let request = &mut ctx.accounts.request;
        
        require!(
            request.status == RequestStatus::Pending,
            ErrorCode::VotingClosed
        );
        
        require!(
            request.votes.len() < MAX_ORACLES,
            ErrorCode::TooManyVotes
        );
        
        let oracle_key = ctx.accounts.oracle.key();
        
        for vote in &request.votes {
            require!(
                vote.oracle != oracle_key,
                ErrorCode::OracleAlreadyVoted
            );
        }
        
        request.votes.push(OracleVote {
            oracle: oracle_key,
            response_hash,
        });
        request.total_votes_cast += 1;
        
        let vote_results = count_votes(&request.votes);
        
        if let Some((winning_hash, vote_count)) = vote_results.iter().max_by_key(|(_, count)| *count) {
            let total_votes = request.total_votes_cast as u64;
            let vote_percentage = ((*vote_count as u64) * 100) / total_votes;
            
            if *vote_count >= request.min_votes && vote_percentage >= request.approval_threshold as u64 {
                request.winning_hash = Some(*winning_hash);
                request.status = RequestStatus::VotingCompleted;
                
                emit!(VotingCompleted {
                    request_id: request.id.clone(),
                    winning_hash: *winning_hash,
                    vote_count: *vote_count,
                    total_votes: request.total_votes_cast,
                });
                
                msg!("Voting completed for request: {}", request.id);
            }
        }
        
        msg!("Vote submitted by oracle: {}", oracle_key);
        
        Ok(())
    }

    pub fn fulfill_request<'info>(
        ctx: Context<'_, '_, '_, 'info, FulfillRequest<'info>>,
        response: Vec<u8>,
    ) -> Result<()> {
        let request = &mut ctx.accounts.request;
        
        require!(
            request.status == RequestStatus::VotingCompleted,
            ErrorCode::VotingNotCompleted
        );
        
        let winning_hash = request.winning_hash.ok_or(ErrorCode::NoWinningHash)?;
        
        let response_hash = hash(&response).to_bytes();
        require!(
            response_hash == winning_hash,
            ErrorCode::ResponseHashMismatch
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

fn count_votes(votes: &[OracleVote]) -> Vec<([u8; 32], u8)> {
    let mut hash_counts: Vec<([u8; 32], u8)> = Vec::new();
    
    for vote in votes {
        let mut found = false;
        for (hash, count) in hash_counts.iter_mut() {
            if *hash == vote.response_hash {
                *count += 1;
                found = true;
                break;
            }
        }
        if !found {
            hash_counts.push((vote.response_hash, 1));
        }
    }
    
    hash_counts
}

#[derive(Accounts)]
#[instruction(request_id: String)]
pub struct CreateRequest<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + 64 + 32 + 64 + 64 
            + (4 + 32 * MAX_CALLBACK_ACCOUNTS) 
            + (4 + 1 * MAX_CALLBACK_ACCOUNTS) 
            + 1 + 8 + 1 + 1 
            + (4 + 64 * MAX_ORACLES) 
            + (1 + 32) 
            + 1,
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
pub struct SubmitVote<'info> {
    #[account(mut)]
    pub request: Account<'info, LLMRequest>,
    pub oracle: Signer<'info>,
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
    pub min_votes: u8,
    pub approval_threshold: u8,
    pub votes: Vec<OracleVote>,
    pub winning_hash: Option<[u8; 32]>,
    pub total_votes_cast: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OracleVote {
    pub oracle: Pubkey,
    pub response_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq)]
pub enum RequestStatus {
    Pending,
    VotingCompleted,
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
    pub min_votes: u8,
    pub approval_threshold: u8,
}

#[event]
pub struct VotingCompleted {
    pub request_id: String,
    pub winning_hash: [u8; 32],
    pub vote_count: u8,
    pub total_votes: u8,
}

#[event]
pub struct RequestFulfilled {
    pub request_id: String,
    pub response_length: u64,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Too many callback accounts (max 32)")]
    TooManyAccounts,
    #[msg("Account mismatch in remaining accounts")]
    AccountMismatch,
    #[msg("Voting is closed or request already fulfilled")]
    VotingClosed,
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
    #[msg("Minimum votes must be greater than 0")]
    InvalidMinVotes,
    #[msg("Approval threshold must be between 1 and 100")]
    InvalidApprovalThreshold,
    #[msg("Oracle has already voted")]
    OracleAlreadyVoted,
    #[msg("Too many votes submitted (max 32 oracles)")]
    TooManyVotes,
    #[msg("Voting has not been completed yet")]
    VotingNotCompleted,
    #[msg("No winning hash available")]
    NoWinningHash,
    #[msg("Response hash does not match winning hash")]
    ResponseHashMismatch,
}