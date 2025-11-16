use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
}

pub struct CoolRouterCPI<'info> {
    pub request_pda: AccountInfo<'info>,
    pub authority: AccountInfo<'info>,
    pub caller_program: AccountInfo<'info>,
    pub system_program: AccountInfo<'info>,
    pub coolrouter_program: Pubkey,
    pub callback_accounts: Vec<AccountInfo<'info>>,
}

impl<'info> CoolRouterCPI<'info> {
    pub fn new(
        request_pda: AccountInfo<'info>,
        authority: AccountInfo<'info>,
        caller_program: AccountInfo<'info>,
        system_program: AccountInfo<'info>,
        coolrouter_program: Pubkey,
    ) -> Self {
        Self {
            request_pda,
            authority,
            caller_program,
            system_program,
            coolrouter_program,
            callback_accounts: Vec::new(),
        }
    }

    pub fn add_callback_account(mut self, account: AccountInfo<'info>) -> Self {
        self.callback_accounts.push(account);
        self
    }

    pub fn add_callback_accounts(mut self, accounts: Vec<AccountInfo<'info>>) -> Self {
        self.callback_accounts.extend(accounts);
        self
    }

    pub fn create_request(
        self,
        request_id: String,
        provider: String,
        model_id: String,
        messages: Vec<Message>,
        min_votes: u8,
        approval_threshold: u8,
    ) -> Result<()> {
        let data = Self::serialize_create_request(
            &request_id,
            &provider,
            &model_id,
            &messages,
            min_votes,
            approval_threshold,
        )?;

        let cpi_accounts = vec![
            self.request_pda.clone(),
            self.authority.clone(),
            self.caller_program.clone(),
            self.system_program.clone(),
        ];

        let mut account_metas = cpi_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect::<Vec<_>>();

        for acc in &self.callback_accounts {
            account_metas.push(AccountMeta {
                pubkey: *acc.key,
                is_signer: false,
                is_writable: true,
            });
        }

        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: self.coolrouter_program,
            accounts: account_metas,
            data,
        };

        let mut all_accounts = cpi_accounts;
        all_accounts.extend(self.callback_accounts);

        anchor_lang::solana_program::program::invoke(&ix, &all_accounts)?;

        Ok(())
    }

    fn serialize_create_request(
        request_id: &str,
        provider: &str,
        model_id: &str,
        messages: &[Message],
        min_votes: u8,
        approval_threshold: u8,
    ) -> Result<Vec<u8>> {
        let mut data = Vec::new();

        let discriminator = Self::calculate_discriminator("global:create_request");
        data.extend_from_slice(&discriminator);

        data.extend_from_slice(&request_id.to_string().try_to_vec()?);
        data.extend_from_slice(&provider.to_string().try_to_vec()?);
        data.extend_from_slice(&model_id.to_string().try_to_vec()?);
        data.extend_from_slice(&messages.to_vec().try_to_vec()?);
        data.extend_from_slice(&min_votes.try_to_vec()?);
        data.extend_from_slice(&approval_threshold.try_to_vec()?);

        Ok(data)
    }

    fn calculate_discriminator(namespace_and_name: &str) -> [u8; 8] {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(namespace_and_name.as_bytes());
        let hash_result = hasher.finalize();
        hash_result[..8].try_into().unwrap()
    }
}

pub fn create_llm_request<'info>(
    request_pda: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    caller_program: AccountInfo<'info>,
    system_program: AccountInfo<'info>,
    coolrouter_program: Pubkey,
    callback_accounts: Vec<AccountInfo<'info>>,
    request_id: String,
    provider: String,
    model_id: String,
    messages: Vec<Message>,
    min_votes: u8,
    approval_threshold: u8,
) -> Result<()> {
    CoolRouterCPI::new(
        request_pda,
        authority,
        caller_program,
        system_program,
        coolrouter_program,
    )
    .add_callback_accounts(callback_accounts)
    .create_request(request_id, provider, model_id, messages, min_votes, approval_threshold)
}