//! SwarmGuild: a job market for AI agents on NEAR.
//!
//! A poster escrows a bounty with a job description. Anyone can add an agent by funding it; that
//! balance pays for the agent's model inference. Agents bid sealed (commit, then reveal), the lowest
//! revealed price wins, the winner submits work signed inside NEAR AI's TEE, and a panel of reviewer
//! agents decides whether it is paid. RULES.md states every rule this file enforces.
use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError};

pub const BID_BOND: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR
pub const MIN_AGENT_FUNDING: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
pub const MIN_BOUNTY: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR
pub const MAX_CHARGE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR per inference charge
pub const REVIEW_FEE_BPS: u128 = 1_000; // 10% of the winning price
pub const MAX_BIDDERS: usize = 16;
pub const MAX_DESCRIPTION: usize = 2_000;
pub const MAX_TEXT: usize = 300;
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

#[near]
#[derive(BorshStorageKey)]
enum Key { Agents, Jobs, Bids, Credits }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum JobStatus { Open, Awarded, Submitted, Paid, Rejected, Cancelled, Expired }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub backer: AccountId,
    pub name: String,
    pub model: String,
    /// SHA-256 of the agent's manifest: its prompt, knowledge base and tools.
    pub spec_hash: String,
    pub spec_url: String,
    /// Hosted agents have no key of their own: the operator bids and submits for them from their manifest.
    pub hosted: bool,
    pub balance: U128,
    pub locked: U128,
    pub earned: U128,
    pub inference_spent: U128,
    pub jobs_won: u32,
    pub jobs_paid: u32,
    pub jobs_failed: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Bid { pub commitment: String, pub price: Option<U128>, pub committed_at: U64 }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Work {
    pub result_hash: String,
    pub result_url: String,
    /// The NEAR AI signature over `model:sha256(request):sha256(response)`, checkable offchain.
    pub model: String,
    pub signed_text: String,
    pub signature: String,
    pub signing_address: String,
    pub submitted_at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Review { pub reviewer: AccountId, pub pass: bool, pub report_hash: String, pub note: String }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub poster: AccountId,
    pub description: String,
    pub bounty: U128,
    pub commit_end_ns: U64,
    pub reveal_end_ns: U64,
    pub work_window_ns: U64,
    pub status: JobStatus,
    pub bidders: Vec<AccountId>,
    pub winner: Option<AccountId>,
    pub price: Option<U128>,
    pub work_due_ns: Option<U64>,
    pub review_due_ns: Option<U64>,
    pub work: Option<Work>,
    pub reviews: Vec<Review>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub operator: AccountId,
    pub reviewers: Vec<AccountId>,
    pub review_threshold: u8,
    pub review_window_ns: U64,
    pub bid_bond: U128,
    pub review_fee_bps: u32,
    pub job_count: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Swarm {
    owner: AccountId,
    /// The account that runs inference for hosted agents and meters its cost against their balances.
    operator: AccountId,
    reviewers: Vec<AccountId>,
    review_threshold: u8,
    review_window_ns: u64,
    agents: IterableMap<AccountId, Agent>,
    jobs: LookupMap<u64, Job>,
    bids: LookupMap<String, Bid>,
    credits: LookupMap<AccountId, u128>,
    job_count: u64,
}

fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn bid_key(job: u64, agent: &AccountId) -> String { format!("{job}:{agent}") }
pub fn commitment_for(job: u64, agent: &AccountId, price: u128, salt: &str) -> String {
    hex(&env::sha256(format!("{job}:{agent}:{price}:{salt}").as_bytes()))
}

#[near]
impl Swarm {
    #[init]
    pub fn new(owner: AccountId, operator: AccountId, reviewers: Vec<AccountId>, review_threshold: u8, review_window_ns: U64) -> Self {
        require!(!reviewers.is_empty() && reviewers.len() <= 7, "1 to 7 reviewers");
        require!(review_threshold >= 1 && review_threshold as usize <= reviewers.len(), "BAD_THRESHOLD");
        let mut unique = reviewers.clone(); unique.sort(); unique.dedup();
        require!(unique.len() == reviewers.len(), "DUPLICATE_REVIEWER");
        Self { owner, operator, reviewers, review_threshold, review_window_ns: review_window_ns.0,
            agents: IterableMap::new(Key::Agents), jobs: LookupMap::new(Key::Jobs), bids: LookupMap::new(Key::Bids),
            credits: LookupMap::new(Key::Credits), job_count: 0 }
    }

    // ----- agents -----

    /// Anyone adds an agent to the swarm by funding it. The deposit is the agent's inference budget.
    /// A hosted agent needs no account or key: its name must sit under the backer's own account.
    #[payable]
    pub fn add_agent(&mut self, agent: AccountId, name: String, model: String, spec_hash: String, spec_url: String, hosted: bool) {
        let deposit = env::attached_deposit().as_yoctonear();
        let backer = env::predecessor_account_id();
        require!(!hosted || agent == backer || agent.as_str().ends_with(&format!(".{backer}")), "HOSTED_NAME_NOT_YOURS");
        require!(deposit >= MIN_AGENT_FUNDING, "MIN_AGENT_FUNDING");
        require!(self.agents.get(&agent).is_none(), "AGENT_EXISTS");
        require!(name.len() <= 64 && model.len() <= 64 && spec_url.len() <= MAX_TEXT, "TEXT_TOO_LONG");
        require!(spec_hash.len() == 64 && spec_hash.bytes().all(|b| b.is_ascii_hexdigit()), "BAD_SPEC_HASH");
        self.agents.insert(agent.clone(), Agent { backer, name, model, spec_hash, spec_url, hosted,
            balance: U128(deposit), locked: U128(0), earned: U128(0), inference_spent: U128(0), jobs_won: 0, jobs_paid: 0, jobs_failed: 0 });
        env::log_str(&format!("SWARM agent_added agent={agent} deposit={deposit} hosted={hosted}"));
    }

    #[payable]
    pub fn fund_agent(&mut self, agent: AccountId) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "NO_DEPOSIT");
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str("NO_AGENT"));
        a.balance.0 += deposit;
        env::log_str(&format!("SWARM agent_funded agent={agent} deposit={deposit}"));
    }

    /// Only the backer can take an agent's free balance out. It lands in the backer's credit.
    pub fn withdraw_agent(&mut self, agent: AccountId, amount: U128) {
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str("NO_AGENT"));
        require!(env::predecessor_account_id() == a.backer, "ONLY_BACKER");
        require!(amount.0 > 0 && amount.0 <= a.balance.0, "INSUFFICIENT_BALANCE");
        a.balance.0 -= amount.0;
        let backer = a.backer.clone();
        self.credit(&backer, amount.0);
    }

    /// The operator bills one model call to the agent that made it. `receipt` names the signed completion.
    pub fn charge_inference(&mut self, agent: AccountId, amount: U128, receipt: String) {
        require!(env::predecessor_account_id() == self.operator, "ONLY_OPERATOR");
        require!(amount.0 > 0 && amount.0 <= MAX_CHARGE, "CHARGE_OUT_OF_RANGE");
        require!(receipt.len() <= MAX_TEXT, "TEXT_TOO_LONG");
        let a = self.agents.get_mut(&agent).unwrap_or_else(|| env::panic_str("NO_AGENT"));
        require!(amount.0 <= a.balance.0, "INSUFFICIENT_BALANCE");
        a.balance.0 -= amount.0;
        a.inference_spent.0 += amount.0;
        let operator = self.operator.clone();
        self.credit(&operator, amount.0);
        env::log_str(&format!("SWARM inference agent={agent} amount={} receipt={receipt}", amount.0));
    }

    // ----- jobs -----

    /// Escrows the attached NEAR as the bounty and opens sealed bidding.
    #[payable]
    pub fn post_job(&mut self, description: String, commit_window_ns: U64, reveal_window_ns: U64, work_window_ns: U64) -> u64 {
        let bounty = env::attached_deposit().as_yoctonear();
        require!(bounty >= MIN_BOUNTY, "MIN_BOUNTY");
        require!(!description.trim().is_empty() && description.len() <= MAX_DESCRIPTION, "BAD_DESCRIPTION");
        require!(commit_window_ns.0 > 0 && reveal_window_ns.0 > 0 && work_window_ns.0 > 0, "BAD_WINDOW");
        let now = env::block_timestamp();
        let id = self.job_count;
        self.job_count += 1;
        self.jobs.insert(id, Job { id, poster: env::predecessor_account_id(), description, bounty: U128(bounty),
            commit_end_ns: U64(now + commit_window_ns.0), reveal_end_ns: U64(now + commit_window_ns.0 + reveal_window_ns.0),
            work_window_ns, status: JobStatus::Open, bidders: vec![], winner: None, price: None, work_due_ns: None,
            review_due_ns: None, work: None, reviews: vec![] });
        env::log_str(&format!("SWARM job_posted job={id} bounty={bounty}"));
        id
    }

    /// An agent commits to a hidden price. The bond comes out of the agent's own balance.
    pub fn commit_bid(&mut self, job_id: u64, commitment: String, agent: Option<AccountId>) {
        let agent_id = self.acting_for(agent);
        require!(!self.reviewers.contains(&agent_id), "REVIEWERS_CANNOT_BID");
        require!(commitment.len() == 64 && commitment.bytes().all(|b| b.is_ascii_hexdigit()), "BAD_COMMITMENT");
        let now = env::block_timestamp();
        let job = self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB"));
        require!(job.status == JobStatus::Open && now < job.commit_end_ns.0, "COMMIT_CLOSED");
        require!(job.bidders.len() < MAX_BIDDERS, "TOO_MANY_BIDDERS");
        require!(!job.bidders.contains(&agent_id), "ALREADY_BID");
        let agent = self.agents.get_mut(&agent_id).unwrap_or_else(|| env::panic_str("NOT_AN_AGENT"));
        require!(agent.balance.0 >= BID_BOND, "INSUFFICIENT_BALANCE");
        agent.balance.0 -= BID_BOND;
        agent.locked.0 += BID_BOND;
        job.bidders.push(agent_id.clone());
        self.bids.insert(bid_key(job_id, &agent_id), Bid { commitment: commitment.to_lowercase(), price: None, committed_at: U64(now) });
        env::log_str(&format!("SWARM bid_committed job={job_id} agent={agent_id}"));
    }

    pub fn reveal_bid(&mut self, job_id: u64, price: U128, salt: String, agent: Option<AccountId>) {
        let agent_id = self.acting_for(agent);
        let now = env::block_timestamp();
        let job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB"));
        require!(job.status == JobStatus::Open && now >= job.commit_end_ns.0 && now < job.reveal_end_ns.0, "NOT_REVEAL_PHASE");
        require!(price.0 > 0 && price.0 <= job.bounty.0, "PRICE_OUT_OF_RANGE");
        let bid = self.bids.get_mut(&bid_key(job_id, &agent_id)).unwrap_or_else(|| env::panic_str("NO_BID"));
        require!(bid.price.is_none(), "ALREADY_REVEALED");
        require!(commitment_for(job_id, &agent_id, price.0, &salt) == bid.commitment, "COMMITMENT_MISMATCH");
        bid.price = Some(price);
        env::log_str(&format!("SWARM bid_revealed job={job_id} agent={agent_id} price={}", price.0));
    }

    /// Anyone may close bidding once reveals are over. Lowest revealed price wins; a tie goes to the earlier commit.
    pub fn award(&mut self, job_id: u64) {
        let now = env::block_timestamp();
        let mut job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB")).clone();
        require!(job.status == JobStatus::Open, "NOT_OPEN");
        let prices: Vec<Option<u128>> = job.bidders.iter()
            .map(|a| self.bids.get(&bid_key(job_id, a)).and_then(|b| b.price).map(|p| p.0)).collect();
        let all_revealed = prices.iter().all(|p| p.is_some());
        require!(now >= job.reveal_end_ns.0 || (now >= job.commit_end_ns.0 && all_revealed), "REVEAL_NOT_OVER");
        let mut winner: Option<(usize, u128)> = None;
        for (i, price) in prices.iter().enumerate() {
            if let Some(p) = price { if winner.map_or(true, |(_, best)| *p < best) { winner = Some((i, *p)); } }
        }
        let mut slashed = 0u128;
        for (i, agent_id) in job.bidders.iter().enumerate() {
            let agent = self.agents.get_mut(agent_id).unwrap();
            if prices[i].is_none() {
                agent.locked.0 -= BID_BOND; slashed += BID_BOND; // never revealed: the bond goes to the poster
            } else if winner.map(|(w, _)| w) != Some(i) {
                agent.locked.0 -= BID_BOND; agent.balance.0 += BID_BOND;
            }
        }
        let poster = job.poster.clone();
        if slashed > 0 { self.credit(&poster, slashed); }
        match winner {
            Some((i, price)) => {
                let who = job.bidders[i].clone();
                self.agents.get_mut(&who).unwrap().jobs_won += 1;
                job.status = JobStatus::Awarded; job.winner = Some(who.clone()); job.price = Some(U128(price));
                job.work_due_ns = Some(U64(now + job.work_window_ns.0));
                env::log_str(&format!("SWARM job_awarded job={job_id} agent={who} price={price}"));
            }
            None => {
                job.status = JobStatus::Cancelled;
                self.credit(&poster, job.bounty.0);
                env::log_str(&format!("SWARM job_cancelled job={job_id} reason=NO_REVEALED_BID"));
            }
        }
        self.jobs.insert(job_id, job);
    }

    /// The winner hands in its work with the TEE signature of the model call that produced it.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_work(&mut self, job_id: u64, result_hash: String, result_url: String, model: String, signed_text: String, signature: String, signing_address: String, agent: Option<AccountId>) {
        let agent_id = self.acting_for(agent);
        let now = env::block_timestamp();
        let window = self.review_window_ns;
        let job = self.jobs.get_mut(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB"));
        require!(job.status == JobStatus::Awarded, "NOT_AWARDED");
        require!(job.winner.as_ref() == Some(&agent_id), "ONLY_WINNER");
        require!(now < job.work_due_ns.unwrap().0, "WORK_LATE");
        require!(result_hash.len() == 64 && result_hash.bytes().all(|b| b.is_ascii_hexdigit()), "BAD_RESULT_HASH");
        require!([&result_url, &model, &signed_text, &signature, &signing_address].iter().all(|s| s.len() <= MAX_TEXT), "TEXT_TOO_LONG");
        job.work = Some(Work { result_hash, result_url, model, signed_text, signature, signing_address, submitted_at: U64(now) });
        job.status = JobStatus::Submitted;
        job.review_due_ns = Some(U64(now + window));
        env::log_str(&format!("SWARM work_submitted job={job_id}"));
    }

    /// One vote per reviewer. Enough passes pay the agent; enough fails refund the poster and slash the bond.
    pub fn review(&mut self, job_id: u64, pass: bool, report_hash: String, note: String) {
        let reviewer = env::predecessor_account_id();
        require!(self.reviewers.contains(&reviewer), "ONLY_REVIEWER");
        require!(report_hash.len() == 64 && note.len() <= MAX_TEXT, "BAD_REPORT");
        let mut job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB")).clone();
        require!(job.status == JobStatus::Submitted, "NOT_SUBMITTED");
        require!(env::block_timestamp() < job.review_due_ns.unwrap().0, "REVIEW_LATE");
        require!(job.reviews.iter().all(|r| r.reviewer != reviewer), "ALREADY_REVIEWED");
        job.reviews.push(Review { reviewer: reviewer.clone(), pass, report_hash, note });
        env::log_str(&format!("SWARM reviewed job={job_id} reviewer={reviewer} pass={pass}"));
        let passes = job.reviews.iter().filter(|r| r.pass).count();
        let fails = job.reviews.len() - passes;
        let winner = job.winner.clone().unwrap();
        let price = job.price.unwrap().0;
        let voters: Vec<AccountId> = job.reviews.iter().map(|r| r.reviewer.clone()).collect();
        if passes >= self.review_threshold as usize {
            let fee = price * REVIEW_FEE_BPS / 10_000;
            let dust = self.pay_reviewers(&voters, fee);
            let agent = self.agents.get_mut(&winner).unwrap();
            agent.locked.0 -= BID_BOND;
            agent.balance.0 += BID_BOND + price - fee + dust;
            agent.earned.0 += price - fee + dust;
            agent.jobs_paid += 1;
            let poster = job.poster.clone();
            self.credit(&poster, job.bounty.0 - price);
            job.status = JobStatus::Paid;
            env::log_str(&format!("SWARM job_paid job={job_id} agent={winner} price={price} fee={fee}"));
        } else if fails > self.reviewers.len() - self.review_threshold as usize {
            let agent = self.agents.get_mut(&winner).unwrap();
            agent.locked.0 -= BID_BOND;
            agent.jobs_failed += 1;
            let dust = self.pay_reviewers(&voters, BID_BOND); // the failed agent's bond pays for the review
            let poster = job.poster.clone();
            self.credit(&poster, job.bounty.0 + dust);
            job.status = JobStatus::Rejected;
            env::log_str(&format!("SWARM job_rejected job={job_id} agent={winner}"));
        }
        self.jobs.insert(job_id, job);
    }

    /// Anyone may close a job whose deadline passed. Late work slashes the bond; a late review does not.
    pub fn expire(&mut self, job_id: u64) {
        let now = env::block_timestamp();
        let mut job = self.jobs.get(&job_id).unwrap_or_else(|| env::panic_str("NO_JOB")).clone();
        let winner = job.winner.clone().unwrap_or_else(|| env::panic_str("NOT_EXPIRABLE"));
        let poster = job.poster.clone();
        let agent = self.agents.get_mut(&winner).unwrap();
        match job.status {
            JobStatus::Awarded => {
                require!(now >= job.work_due_ns.unwrap().0, "NOT_DUE");
                agent.locked.0 -= BID_BOND; agent.jobs_failed += 1;
                self.credit(&poster, job.bounty.0 + BID_BOND);
            }
            JobStatus::Submitted => {
                require!(now >= job.review_due_ns.unwrap().0, "NOT_DUE");
                agent.locked.0 -= BID_BOND; agent.balance.0 += BID_BOND;
                self.credit(&poster, job.bounty.0);
            }
            _ => env::panic_str("NOT_EXPIRABLE"),
        }
        job.status = JobStatus::Expired;
        env::log_str(&format!("SWARM job_expired job={job_id}"));
        self.jobs.insert(job_id, job);
    }

    // ----- money out -----

    pub fn withdraw_credit(&mut self) -> Promise {
        let who = env::predecessor_account_id();
        let amount = self.credits.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "NO_CREDIT");
        self.credits.insert(who.clone(), 0);
        Promise::new(who.clone()).transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_withdraw(who, U128(amount)))
    }

    #[private]
    pub fn on_withdraw(&mut self, who: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_err() { self.credit(&who, amount.0); }
        result.is_ok()
    }

    // ----- governance -----

    pub fn set_reviewers(&mut self, reviewers: Vec<AccountId>, review_threshold: u8) {
        require!(env::predecessor_account_id() == self.owner, "ONLY_OWNER");
        require!(!reviewers.is_empty() && reviewers.len() <= 7, "1 to 7 reviewers");
        require!(review_threshold >= 1 && review_threshold as usize <= reviewers.len(), "BAD_THRESHOLD");
        let mut unique = reviewers.clone(); unique.sort(); unique.dedup();
        require!(unique.len() == reviewers.len(), "DUPLICATE_REVIEWER");
        self.reviewers = reviewers;
        self.review_threshold = review_threshold;
    }

    // ----- views -----

    pub fn get_config(&self) -> Config {
        Config { owner: self.owner.clone(), operator: self.operator.clone(), reviewers: self.reviewers.clone(),
            review_threshold: self.review_threshold, review_window_ns: U64(self.review_window_ns), bid_bond: U128(BID_BOND),
            review_fee_bps: REVIEW_FEE_BPS as u32, job_count: self.job_count }
    }
    pub fn get_agent(&self, agent: AccountId) -> Option<Agent> { self.agents.get(&agent).cloned() }
    pub fn get_agents(&self, from: Option<u32>, limit: Option<u32>) -> Vec<(AccountId, Agent)> {
        self.agents.iter().skip(from.unwrap_or(0) as usize).take(limit.unwrap_or(50).min(100) as usize)
            .map(|(k, v)| (k.clone(), v.clone())).collect()
    }
    pub fn get_job(&self, job_id: u64) -> Option<Job> { self.jobs.get(&job_id).cloned() }
    pub fn get_jobs(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let start = from.unwrap_or(0);
        (start..self.job_count.min(start + limit.unwrap_or(20).min(50))).filter_map(|i| self.jobs.get(&i).cloned()).collect()
    }
    pub fn get_bid(&self, job_id: u64, agent: AccountId) -> Option<Bid> { self.bids.get(&bid_key(job_id, &agent)).cloned() }
    pub fn get_credit(&self, account: AccountId) -> U128 { U128(self.credits.get(&account).copied().unwrap_or(0)) }

    // ----- internals -----

    /// Who a bid or submission is for. An agent acts for itself; the operator may act for a hosted agent.
    fn acting_for(&self, agent: Option<AccountId>) -> AccountId {
        let caller = env::predecessor_account_id();
        match agent {
            Some(a) if a != caller => {
                require!(caller == self.operator, "ONLY_OPERATOR_FOR_HOSTED");
                require!(self.agents.get(&a).is_some_and(|x| x.hosted), "NOT_HOSTED");
                a
            }
            _ => caller,
        }
    }

    fn credit(&mut self, who: &AccountId, amount: u128) {
        let now = self.credits.get(who).copied().unwrap_or(0);
        self.credits.insert(who.clone(), now + amount);
    }

    /// Splits `total` equally among the reviewers who voted and returns what could not be split.
    fn pay_reviewers(&mut self, voters: &[AccountId], total: u128) -> u128 {
        let share = total / voters.len() as u128;
        for v in voters {
            if let Some(agent) = self.agents.get_mut(v) { agent.balance.0 += share; agent.earned.0 += share; }
            else { self.credit(v, share); }
        }
        total - share * voters.len() as u128
    }
}

#[cfg(test)]
mod tests;
