//! Keyhole's sandbox smoke-test contract (Task 11). Built in-repo by `npm run build:counter`
//! (`cargo near build non-reproducible-wasm --locked`), which embeds the near-abi that Keyhole reads back
//! through the `__contract_abi` view to derive the counter pack's tools.
//!
//! Three call methods, one per classifier label at wrap time:
//! - `increment`: callable with a function-call key (0 deposit);
//! - `reset`: needs exactly 1 yoctoNEAR, which a function-call key can never attach (fails at runtime);
//! - `transfer_ownership`: the owner's only; the pack keeps it out of scope.

use near_sdk::{AccountId, PanicOnDefault, env, near, require};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Counter {
    value: u64,
    owner: AccountId,
}

#[near]
impl Counter {
    /// Starts at 0, owned by `owner`.
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self { value: 0, owner }
    }

    /// Adds 1 and returns the new value.
    pub fn increment(&mut self) -> u64 {
        self.value += 1;
        self.value
    }

    /// Sets the value back to 0. Requires an attached deposit of exactly 1 yoctoNEAR.
    #[payable]
    pub fn reset(&mut self) {
        near_sdk::assert_one_yocto();
        self.value = 0;
    }

    /// Hands the contract to `new_owner`. Only the current owner may call it.
    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        self.owner = new_owner;
    }

    /// The current value.
    pub fn get_value(&self) -> u64 {
        self.value
    }
}
