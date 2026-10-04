use hdk::prelude::*;
use relay_integrity::*;

use crate::helper::ZomeFnInput;

fn roles_path() -> Path {
    Path::from("roles")
}

fn progenitor() -> ExternResult<Option<AgentPubKey>> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() == 1 {
        return Ok(None);
    }
    let props = Properties::try_from(info.modifiers.properties).map_err(|e| wasm_error!(e))?;
    Ok(Some(props.progenitor))
}

fn live_role_grants(role: GrantedRole) -> ExternResult<Vec<(ActionHash, RoleGrant)>> {
    let links = get_links(
        LinkQuery {
            base: roles_path().path_entry_hash()?.into(),
            link_type: LinkTypes::AllRoleGrants.try_into_filter()?,
            tag_prefix: None,
            after: None,
            before: None,
            author: None,
        },
        GetStrategy::Local,
    )?;
    let mut grants = Vec::new();
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else {
            continue;
        };
        let Some(Details::Record(details)) =
            get_details(action_hash.clone(), GetOptions::local())?
        else {
            continue;
        };
        if !details.deletes.is_empty() {
            continue;
        }
        let Some(role_grant): Option<RoleGrant> = details
            .record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
        else {
            continue;
        };
        if role_grant.role == role {
            grants.push((action_hash, role_grant));
        }
    }
    Ok(grants)
}

pub fn find_role_grant(agent: &AgentPubKey, role: GrantedRole) -> ExternResult<Option<ActionHash>> {
    Ok(live_role_grants(role)?
        .into_iter()
        .find(|(_, role_grant)| &role_grant.for_agent == agent)
        .map(|(action_hash, _)| action_hash))
}

#[hdk_extern]
pub fn get_moderators(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    Ok(live_role_grants(GrantedRole::Moderator)?
        .into_iter()
        .map(|(_, role_grant)| role_grant.for_agent)
        .collect())
}

#[hdk_extern]
pub fn get_writers(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    Ok(live_role_grants(GrantedRole::Writer)?
        .into_iter()
        .map(|(_, role_grant)| role_grant.for_agent)
        .collect())
}

pub fn find_message_role_evidence() -> ExternResult<Option<ActionHash>> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() == 1 {
        return Ok(None);
    }
    let props = Properties::try_from(info.modifiers.properties).map_err(|e| wasm_error!(e))?;
    let me = agent_info()?.agent_initial_pubkey;
    if props.progenitor == me {
        return Ok(None);
    }
    if props.mode != ConversationMode::ModeratedReadOnly {
        return find_membership(&me);
    }
    match find_role_grant(&me, GrantedRole::Moderator)? {
        Some(hash) => Ok(Some(hash)),
        None => find_role_grant(&me, GrantedRole::Writer),
    }
}

#[hdk_extern]
pub fn get_role(input: ZomeFnInput<AgentPubKey>) -> ExternResult<ConversationRole> {
    if progenitor()?.is_some_and(|owner| owner == input.input) {
        return Ok(ConversationRole::Owner);
    }
    Ok(if find_role_grant(&input.input, GrantedRole::Moderator)?.is_some() {
        ConversationRole::Moderator
    } else {
        ConversationRole::Member
    })
}

#[hdk_extern]
pub fn grant_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    create_role_grant(agent, GrantedRole::Moderator, None)
}

#[hdk_extern]
pub fn revoke_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    let Some(role_grant_hash) = find_role_grant(&agent, GrantedRole::Moderator)? else {
        return Ok(());
    };
    delete_entry(role_grant_hash)?;
    Ok(())
}

#[hdk_extern]
pub fn grant_writer_role(agent: AgentPubKey) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let granter_evidence = find_role_grant(&me, GrantedRole::Moderator)?;
    create_role_grant(agent, GrantedRole::Writer, granter_evidence)
}

#[hdk_extern]
pub fn revoke_writer_role(agent: AgentPubKey) -> ExternResult<()> {
    let Some(role_grant_hash) = find_role_grant(&agent, GrantedRole::Writer)? else {
        return Ok(());
    };
    delete_as_authority(role_grant_hash)
}

fn create_role_grant(
    agent: AgentPubKey,
    role: GrantedRole,
    granter_evidence: Option<ActionHash>,
) -> ExternResult<()> {
    let role_grant_hash = create_entry(&EntryTypes::RoleGrant(RoleGrant {
        for_agent: agent,
        role,
        granter_evidence,
    }))?;
    create_link(
        roles_path().path_entry_hash()?,
        role_grant_hash,
        LinkTypes::AllRoleGrants,
        (),
    )?;
    Ok(())
}

fn live_memberships() -> ExternResult<Vec<(ActionHash, Membership)>> {
    let links = get_links(
        LinkQuery {
            base: Path::from("members").path_entry_hash()?.into(),
            link_type: LinkTypes::AllMemberships.try_into_filter()?,
            tag_prefix: None,
            after: None,
            before: None,
            author: None,
        },
        GetStrategy::Local,
    )?;
    let mut memberships = Vec::new();
    for link in links {
        let Some(action_hash) = link.target.into_action_hash() else {
            continue;
        };
        let Some(Details::Record(details)) =
            get_details(action_hash.clone(), GetOptions::local())?
        else {
            continue;
        };
        if !details.deletes.is_empty() {
            continue;
        }
        let Some(membership): Option<Membership> = details
            .record
            .entry()
            .to_app_option()
            .map_err(|e| wasm_error!(e))?
        else {
            continue;
        };
        memberships.push((action_hash, membership));
    }
    Ok(memberships)
}

fn find_membership(agent: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
    Ok(live_memberships()?
        .into_iter()
        .find(|(_, membership)| &membership.for_agent == agent)
        .map(|(action_hash, _)| action_hash))
}

#[hdk_extern]
pub fn get_members(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    Ok(live_memberships()?
        .into_iter()
        .map(|(_, membership)| membership.for_agent)
        .collect())
}

#[hdk_extern]
pub fn create_membership(_: ()) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let membership_hash = create_entry(&EntryTypes::Membership(Membership { for_agent: me }))?;
    create_link(
        Path::from("members").path_entry_hash()?,
        membership_hash,
        LinkTypes::AllMemberships,
        (),
    )?;
    Ok(())
}

#[hdk_extern]
pub fn remove_member(agent: AgentPubKey) -> ExternResult<()> {
    for role in [GrantedRole::Writer, GrantedRole::Moderator] {
        if let Some(role_grant_hash) = find_role_grant(&agent, role)? {
            delete_as_authority(role_grant_hash)?;
        }
    }
    if let Some(membership_hash) = find_membership(&agent)? {
        delete_as_authority(membership_hash)?;
    }
    Ok(())
}

fn delete_as_authority(hash: ActionHash) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    if progenitor()?.is_none_or(|owner| owner != me) {
        if let Some(moderator_evidence) = find_role_grant(&me, GrantedRole::Moderator)? {
            create_entry(&EntryTypes::RoleEvidenceEntry(RoleEvidenceEntry {
                role_evidence: moderator_evidence,
            }))?;
        }
    }
    delete_entry(hash)?;
    Ok(())
}
