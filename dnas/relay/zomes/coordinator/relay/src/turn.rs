use hdk::prelude::*;

const TURN_PROOF_DOMAIN: &[u8] = b"k2-turn-cred-v1";
const NONCE_LEN: usize = 32;

#[derive(Serialize, Deserialize, Debug)]
pub struct TurnProof {
    #[serde(with = "serde_bytes")]
    pub space: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub agent: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

#[hdk_extern]
pub fn sign_turn_challenge(nonce: serde_bytes::ByteBuf) -> ExternResult<TurnProof> {
    if nonce.len() != NONCE_LEN {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "TURN nonce must be {NONCE_LEN} bytes, got {}",
            nonce.len()
        ))));
    }

    let space = dna_info()?.hash.get_raw_32().to_vec();
    let me = agent_info()?.agent_initial_pubkey;
    let agent = me.get_raw_32().to_vec();

    let mut msg = Vec::with_capacity(TURN_PROOF_DOMAIN.len() + NONCE_LEN + space.len() + agent.len());
    msg.extend_from_slice(TURN_PROOF_DOMAIN);
    msg.extend_from_slice(&nonce);
    msg.extend_from_slice(&space);
    msg.extend_from_slice(&agent);

    let signature = sign_raw(me, msg)?;

    Ok(TurnProof {
        space,
        agent,
        signature: signature.0.to_vec(),
    })
}
