use hdk::prelude::*;

#[hdk_extern]
pub fn ping(_: ()) -> ExternResult<()> {
    Ok(())
}

#[hdk_extern]
pub fn ping_agents(agents: Vec<AgentPubKey>) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let signal = crate::RemoteSignalPayload::PeerPing { from_agent: me };
    send_remote_signal(signal, agents)?;
    Ok(())
}

pub fn handle_peer_ping(from_agent: AgentPubKey) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let pong = crate::RemoteSignalPayload::PeerPong { from_agent: me };
    send_remote_signal(pong, vec![from_agent.clone()])?;
    emit_signal(crate::Signal::PeerPing { from_agent })?;
    Ok(())
}

pub fn handle_peer_pong(from_agent: AgentPubKey) -> ExternResult<()> {
    emit_signal(crate::Signal::PeerPong { from_agent })?;
    Ok(())
}