use hdk::prelude::*;
use relay_integrity::*;

use crate::helper::ZomeFnInput;

fn roles_path() -> Path {
    Path::from("roles")
}

#[hdk_extern]
pub fn get_role(input: ZomeFnInput<AgentPubKey>) -> ExternResult<ConversationRole> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() > 1 {
        let props = Properties::try_from(info.modifiers.properties).map_err(|e| wasm_error!(e))?;
        if input.input == props.progenitor {
            return Ok(ConversationRole::Owner);
        }
    }

    let links = get_links(
        LinkQuery {
            base: roles_path().path_entry_hash()?.into(),
            link_type: LinkTypes::RoleGrant.try_into_filter()?,
            tag_prefix: Some(LinkTag::new(MODERATOR_ROLE_TAG)),
            after: None,
            before: None,
            author: None,
        },
        input.get_strategy(),
    )?;
    let is_moderator = links
        .into_iter()
        .any(|link| link.target.into_agent_pub_key().map(|a| a == input.input).unwrap_or(false));

    Ok(if is_moderator { ConversationRole::Moderator } else { ConversationRole::Member })
}

#[hdk_extern]
pub fn grant_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    create_link(
        roles_path().path_entry_hash()?,
        agent,
        LinkTypes::RoleGrant,
        LinkTag::new(MODERATOR_ROLE_TAG),
    )?;
    Ok(())
}

#[hdk_extern]
pub fn revoke_moderator_role(agent: AgentPubKey) -> ExternResult<()> {
    let links = get_links(
        LinkQuery {
            base: roles_path().path_entry_hash()?.into(),
            link_type: LinkTypes::RoleGrant.try_into_filter()?,
            tag_prefix: Some(LinkTag::new(MODERATOR_ROLE_TAG)),
            after: None,
            before: None,
            author: None,
        },
        GetStrategy::Local,
    )?;
    for link in links {
        if link.target.into_agent_pub_key().map(|a| a == agent).unwrap_or(false) {
            delete_link(link.create_link_hash, GetOptions::local())?;
        }
    }
    Ok(())
}
