use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum ConversationRole {
    Owner,
    Moderator,
    Member,
}

pub const MODERATOR_ROLE_TAG: &str = "Moderator";

pub fn validate_create_link_role_grant(
    action: CreateLink,
    base_address: AnyLinkableHash,
    _target_address: AnyLinkableHash,
    tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("roles").path_entry_hash()?;
    let base_hash = base_address.into_entry_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No entry hash associated with link".to_string())
    ))?;
    if base_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "Role grants must be linked from the roles anchor".to_string(),
        ));
    }
    validate_role_tag_author(&tag, action.author)
}

pub fn validate_delete_link_role_grant(
    action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    validate_role_tag_author(&tag, action.author)
}

fn validate_role_tag_author(
    tag: &LinkTag,
    author: AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    match tag.0.as_slice() {
        t if t == MODERATOR_ROLE_TAG.as_bytes() => owner_only(author),
        _ => Ok(ValidateCallbackResult::Invalid("Unknown role tag".to_string())),
    }
}

fn owner_only(author: AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() == 1 {
        return Ok(ValidateCallbackResult::Valid);
    }
    let props = crate::Properties::try_from(info.modifiers.properties).map_err(|e| wasm_error!(e))?;
    if author == props.progenitor {
        Ok(ValidateCallbackResult::Valid)
    } else {
        Ok(ValidateCallbackResult::Invalid(
            "Only the conversation owner may grant or revoke this role".to_string(),
        ))
    }
}
