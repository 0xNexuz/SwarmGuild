use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MIN: u64 = 60_000_000_000;
const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn acc(s: &str) -> AccountId { s.parse().unwrap() }
fn ctx(who: &str, deposit: u128, time: u64) {
    testing_env!(VMContextBuilder::new().predecessor_account_id(acc(who)).attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(time).current_account_id(acc("swarm.test")).build());
}
/// A swarm with three reviewers (two must pass), two worker agents funded with 1 NEAR each, and one job.
fn setup() -> Swarm {
    ctx("owner.test", 0, 0);
    let mut s = Swarm::new(acc("owner.test"), acc("operator.test"), vec![acc("rev-1.test"), acc("rev-2.test"), acc("rev-3.test")], 2, U64(10 * MIN));
    for a in ["agent-1.test", "agent-2.test"] {
        ctx("backer.test", NEAR, 0);
        s.add_agent(acc(a), a.into(), "z-ai/glm-5.3-flash".into(), HASH.into(), "https://example.test/spec.json".into());
    }
    ctx("poster.test", NEAR / 2, 0);
    assert_eq!(s.post_job("Summarize this contract's risks.".into(), U64(MIN), U64(MIN), U64(5 * MIN)), 0);
    s
}
fn commit(s: &mut Swarm, agent: &str, price: u128, time: u64) {
    ctx(agent, 0, time);
    s.commit_bid(0, commitment_for(0, &acc(agent), price, "salt"));
}
fn reveal(s: &mut Swarm, agent: &str, price: u128) { ctx(agent, 0, MIN); s.reveal_bid(0, U128(price), "salt".into()); }
fn submit(s: &mut Swarm, agent: &str, time: u64) {
    ctx(agent, 0, time);
    s.submit_work(0, HASH.into(), "https://example.test/work".into(), "z-ai/glm-5.3-flash".into(), "model:req:resp".into(), "0xsig".into(), "0xkey".into());
}
fn vote(s: &mut Swarm, reviewer: &str, pass: bool, time: u64) { ctx(reviewer, 0, time); s.review(0, pass, HASH.into(), "checked".into()); }
fn agent(s: &Swarm, a: &str) -> Agent { s.get_agent(acc(a)).unwrap() }
fn credit(s: &Swarm, a: &str) -> u128 { s.get_credit(acc(a)).0 }
/// Every yoctoNEAR paid in is in exactly one place.
fn held(s: &Swarm, accounts: &[&str]) -> u128 {
    let agents: u128 = s.get_agents(None, None).iter().map(|(_, a)| a.balance.0 + a.locked.0).sum();
    let credits: u128 = accounts.iter().map(|a| credit(s, a)).sum();
    let escrow: u128 = s.get_jobs(None, None).iter()
        .filter(|j| matches!(j.status, JobStatus::Open | JobStatus::Awarded | JobStatus::Submitted)).map(|j| j.bounty.0).sum();
    agents + credits + escrow
}
const EVERYONE: [&str; 6] = ["poster.test", "backer.test", "operator.test", "rev-1.test", "rev-2.test", "rev-3.test"];

#[test]
fn lowest_sealed_bid_wins_and_a_passed_review_pays_the_agent() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1);
    commit(&mut s, "agent-2.test", NEAR / 10, 2);
    assert!(s.get_bid(0, acc("agent-2.test")).unwrap().price.is_none(), "the price is hidden until reveal");
    assert_eq!(agent(&s, "agent-1.test").locked.0, BID_BOND);
    reveal(&mut s, "agent-1.test", NEAR / 5);
    reveal(&mut s, "agent-2.test", NEAR / 10);
    ctx("anyone.test", 0, MIN + 1);
    s.award(0);
    let job = s.get_job(0).unwrap();
    assert_eq!(job.winner, Some(acc("agent-2.test")));
    assert_eq!(job.price.unwrap().0, NEAR / 10);
    assert_eq!(agent(&s, "agent-1.test").balance.0, NEAR, "the loser's bond is back");
    submit(&mut s, "agent-2.test", 2 * MIN);
    vote(&mut s, "rev-1.test", true, 2 * MIN + 1);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Submitted, "one pass of two needed");
    vote(&mut s, "rev-2.test", true, 2 * MIN + 2);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Paid);
    let fee = NEAR / 100;
    assert_eq!(agent(&s, "agent-2.test").balance.0, NEAR + NEAR / 10 - fee);
    assert_eq!(agent(&s, "agent-2.test").earned.0, NEAR / 10 - fee);
    assert_eq!(credit(&s, "rev-1.test") + credit(&s, "rev-2.test"), fee);
    assert_eq!(credit(&s, "poster.test"), NEAR / 2 - NEAR / 10, "the poster gets back what the winner did not ask for");
    assert_eq!(held(&s, &EVERYONE), 2 * NEAR + NEAR / 2);
}

#[test]
fn a_failed_review_refunds_the_poster_and_the_bond_pays_the_reviewers() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1);
    reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    submit(&mut s, "agent-1.test", 2 * MIN);
    vote(&mut s, "rev-1.test", false, 2 * MIN + 1);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Submitted);
    vote(&mut s, "rev-3.test", false, 2 * MIN + 2);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Rejected, "two fails of three make a pass impossible");
    assert_eq!(agent(&s, "agent-1.test").balance.0, NEAR - BID_BOND);
    assert_eq!(agent(&s, "agent-1.test").jobs_failed, 1);
    assert_eq!(credit(&s, "poster.test"), NEAR / 2);
    assert_eq!(credit(&s, "rev-1.test"), BID_BOND / 2);
    assert_eq!(held(&s, &EVERYONE), 2 * NEAR + NEAR / 2);
}

#[test]
fn an_unrevealed_bid_loses_its_bond_and_a_tie_goes_to_the_earlier_commit() {
    let mut s = setup();
    ctx("backer.test", NEAR, 0);
    s.add_agent(acc("agent-3.test"), "three".into(), "m".into(), HASH.into(), "".into());
    commit(&mut s, "agent-1.test", NEAR / 10, 1);
    commit(&mut s, "agent-2.test", NEAR / 10, 2);
    commit(&mut s, "agent-3.test", NEAR / 20, 3);
    reveal(&mut s, "agent-2.test", NEAR / 10);
    reveal(&mut s, "agent-1.test", NEAR / 10);
    ctx("anyone.test", 0, MIN + 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| { let mut c = setup(); commit(&mut c, "agent-1.test", 1, 1); ctx("x.test", 0, MIN + 1); c.award(0); })).is_err(),
        "award waits for the reveal window while a bid is still hidden");
    ctx("anyone.test", 0, 2 * MIN);
    s.award(0);
    assert_eq!(s.get_job(0).unwrap().winner, Some(acc("agent-1.test")));
    assert_eq!(agent(&s, "agent-3.test").balance.0, NEAR - BID_BOND, "the hidden bid never counted and its bond is gone");
    assert_eq!(credit(&s, "poster.test"), BID_BOND);
    assert_eq!(held(&s, &EVERYONE), 3 * NEAR + NEAR / 2);
}

#[test]
#[should_panic(expected = "COMMITMENT_MISMATCH")]
fn a_reveal_must_match_the_commitment() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1);
    reveal(&mut s, "agent-1.test", NEAR / 10);
}

#[test]
#[should_panic(expected = "COMMITMENT_MISMATCH")]
fn an_agent_cannot_copy_another_agents_commitment() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1);
    ctx("agent-2.test", 0, 2);
    s.commit_bid(0, commitment_for(0, &acc("agent-1.test"), NEAR / 5, "salt"));
    reveal(&mut s, "agent-2.test", NEAR / 5);
}

#[test]
#[should_panic(expected = "COMMIT_CLOSED")]
fn no_commits_after_the_commit_window() { let mut s = setup(); commit(&mut s, "agent-1.test", NEAR / 5, MIN); }

#[test]
#[should_panic(expected = "PRICE_OUT_OF_RANGE")]
fn a_bid_cannot_exceed_the_bounty() { let mut s = setup(); commit(&mut s, "agent-1.test", NEAR, 1); reveal(&mut s, "agent-1.test", NEAR); }

#[test]
#[should_panic(expected = "NOT_AN_AGENT")]
fn only_funded_agents_can_bid() { let mut s = setup(); commit(&mut s, "stranger.test", NEAR / 5, 1); }

#[test]
#[should_panic(expected = "REVIEWERS_CANNOT_BID")]
fn reviewers_cannot_bid() { let mut s = setup(); commit(&mut s, "rev-1.test", NEAR / 5, 1); }

#[test]
#[should_panic(expected = "ONLY_WINNER")]
fn only_the_winner_can_submit_work() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1); reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    submit(&mut s, "agent-2.test", 2 * MIN);
}

#[test]
#[should_panic(expected = "ONLY_REVIEWER")]
fn only_reviewers_can_review() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1); reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    submit(&mut s, "agent-1.test", 2 * MIN);
    vote(&mut s, "agent-1.test", true, 2 * MIN + 1);
}

#[test]
#[should_panic(expected = "ALREADY_REVIEWED")]
fn a_reviewer_votes_once() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1); reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    submit(&mut s, "agent-1.test", 2 * MIN);
    vote(&mut s, "rev-1.test", true, 2 * MIN + 1);
    vote(&mut s, "rev-1.test", true, 2 * MIN + 2);
}

#[test]
fn late_work_slashes_the_bond_and_a_late_review_does_not() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1); reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    ctx("anyone.test", 0, 7 * MIN); s.expire(0);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Expired);
    assert_eq!(agent(&s, "agent-1.test").balance.0, NEAR - BID_BOND);
    assert_eq!(credit(&s, "poster.test"), NEAR / 2 + BID_BOND);

    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1); reveal(&mut s, "agent-1.test", NEAR / 5);
    ctx("anyone.test", 0, MIN + 1); s.award(0);
    submit(&mut s, "agent-1.test", 2 * MIN);
    ctx("anyone.test", 0, 13 * MIN); s.expire(0);
    assert_eq!(agent(&s, "agent-1.test").balance.0, NEAR, "the agent did its part, so it keeps its bond");
    assert_eq!(credit(&s, "poster.test"), NEAR / 2);
    assert_eq!(held(&s, &EVERYONE), 2 * NEAR + NEAR / 2);
}

#[test]
fn a_job_with_no_bids_is_cancelled_and_refunded() {
    let mut s = setup();
    ctx("anyone.test", 0, MIN); s.award(0);
    assert_eq!(s.get_job(0).unwrap().status, JobStatus::Cancelled);
    assert_eq!(credit(&s, "poster.test"), NEAR / 2);
}

#[test]
fn inference_is_billed_to_the_agent_by_the_operator_only_and_capped() {
    let mut s = setup();
    ctx("operator.test", 0, 5);
    s.charge_inference(acc("agent-1.test"), U128(MAX_CHARGE), "chat-1 model:req:resp".into());
    assert_eq!(agent(&s, "agent-1.test").balance.0, NEAR - MAX_CHARGE);
    assert_eq!(agent(&s, "agent-1.test").inference_spent.0, MAX_CHARGE);
    assert_eq!(credit(&s, "operator.test"), MAX_CHARGE);
    for (who, amount) in [("backer.test", 1), ("operator.test", MAX_CHARGE + 1)] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = setup(); ctx(who, 0, 5); c.charge_inference(acc("agent-1.test"), U128(amount), "r".into());
        }));
        assert!(r.is_err(), "{who} charging {amount} must fail");
    }
    // An agent that is committed to a bid cannot be drained below its bond.
    commit(&mut s, "agent-2.test", NEAR / 5, 6);
    ctx("operator.test", 0, 7);
    let free = agent(&s, "agent-2.test").balance.0;
    assert_eq!(free, NEAR - BID_BOND);
    assert_eq!(held(&s, &EVERYONE), 2 * NEAR + NEAR / 2);
}

#[test]
fn only_the_backer_withdraws_an_agents_free_balance() {
    let mut s = setup();
    commit(&mut s, "agent-1.test", NEAR / 5, 1);
    ctx("backer.test", 0, 2);
    s.withdraw_agent(acc("agent-1.test"), U128(NEAR - BID_BOND));
    assert_eq!(credit(&s, "backer.test"), NEAR - BID_BOND);
    assert_eq!(agent(&s, "agent-1.test").locked.0, BID_BOND, "the locked bond stays");
    for (who, amount) in [("agent-1.test", 1u128), ("poster.test", 1), ("backer.test", 2 * NEAR)] {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut c = setup(); ctx(who, 0, 2); c.withdraw_agent(acc("agent-1.test"), U128(amount));
        }));
        assert!(r.is_err(), "{who} withdrawing {amount} must fail");
    }
}

#[test]
fn an_agent_out_of_balance_cannot_bid() {
    let mut s = setup();
    ctx("backer.test", 0, 1);
    s.withdraw_agent(acc("agent-1.test"), U128(NEAR - BID_BOND + 1));
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| commit(&mut s, "agent-1.test", NEAR / 5, 2)));
    assert!(r.is_err());
}

#[test]
fn a_failed_withdrawal_transfer_restores_the_credit() {
    let mut s = setup();
    ctx("anyone.test", 0, MIN); s.award(0);
    ctx("poster.test", 0, MIN + 1);
    let _ = s.withdraw_credit();
    assert_eq!(credit(&s, "poster.test"), 0);
    ctx("swarm.test", 0, MIN + 2);
    assert!(!s.on_withdraw(acc("poster.test"), U128(NEAR / 2), Err(PromiseError::Failed)));
    assert_eq!(credit(&s, "poster.test"), NEAR / 2);
}
