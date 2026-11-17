use hdk::prelude::*;

const TURN_PROOF_DOMAIN: &[u8] = b"volla-turn-cred-v2";
const NONCE_LEN: usize = 32;

#[derive(Serialize, Deserialize, Debug)]
pub struct TurnChallenge {
    pub nonce: serde_bytes::ByteBuf,
    pub device: AgentPubKey,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TurnProof {
    #[serde(with = "serde_bytes")]
    pub device: Vec<u8>,
    #[serde(with = "serde_bytes")]
    pub signature: Vec<u8>,
}

#[hdk_extern]
pub fn sign_turn_challenge(input: TurnChallenge) -> ExternResult<TurnProof> {
    if input.nonce.len() != NONCE_LEN {
        return Err(wasm_error!(WasmErrorInner::Guest(format!(
            "TURN nonce must be {NONCE_LEN} bytes, got {}",
            input.nonce.len()
        ))));
    }

    let device = input.device.get_raw_32().to_vec();
    let msg = [TURN_PROOF_DOMAIN, &input.nonce, &device].concat();
    let signature = sign_raw(input.device, msg)?;

    Ok(TurnProof {
        device,
        signature: signature.0.to_vec(),
    })
}
