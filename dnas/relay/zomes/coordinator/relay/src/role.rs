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

pub fn find_role_grant(agent: &AgentPubKey) -> ExternResult<Option<ActionHash>> {
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
        if &role_grant.for_agent == agent {
            return Ok(Some(action_hash));
        }
    }
    Ok(None)
}

#[hdk_extern]
pub fn get_role(input: ZomeFnInput<AgentPubKey>) -> ExternResult<ConversationRole> {
    if progenitor()?.is_some_and(|owner| owner == input.input) {
        return Ok(ConversationRole::Owner);
    }
    Ok(if find_role_grant(&input.input)?.is_some() {
        ConversationRole::Moderator
    } else {
        ConversationRole::Member
    })
}

#[hdk_extern]
pub fn grant_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    let role_grant_hash = create_entry(&EntryTypes::RoleGrant(RoleGrant { for_agent: agent }))?;
    create_link(
        roles_path().path_entry_hash()?,
        role_grant_hash,
        LinkTypes::AllRoleGrants,
        (),
    )?;
    Ok(())
}

#[hdk_extern]
pub fn revoke_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    let Some(role_grant_hash) = find_role_grant(&agent)? else {
        return Ok(());
    };
    delete_entry(role_grant_hash)?;
    Ok(())
}
