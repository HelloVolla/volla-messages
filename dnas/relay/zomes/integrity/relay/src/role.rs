use hdi::prelude::*;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum ConversationRole {
    Owner,
    Moderator,
    Member,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub enum GrantedRole {
    Moderator,
    Writer,
}

#[derive(Clone, PartialEq)]
#[hdk_entry_helper]
pub struct RoleGrant {
    pub for_agent: AgentPubKey,
    pub role: GrantedRole,
    pub granter_evidence: Option<ActionHash>,
}

pub fn validate_create_role_grant(
    action: EntryCreationAction,
    role_grant: RoleGrant,
) -> ExternResult<ValidateCallbackResult> {
    match role_grant.role {
        GrantedRole::Moderator => require_owner(action.author()),
        GrantedRole::Writer => {
            require_owner_or_moderator(action.author(), role_grant.granter_evidence)
        }
    }
}

pub fn validate_update_role_grant(
    _action: Update,
    _role_grant: RoleGrant,
    _original_action: EntryCreationAction,
    _original_role_grant: RoleGrant,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "RoleGrant entries cannot be updated".to_string(),
    ))
}

pub fn validate_delete_role_grant(
    action: Delete,
    _original_action: EntryCreationAction,
    original_role_grant: RoleGrant,
) -> ExternResult<ValidateCallbackResult> {
    match original_role_grant.role {
        GrantedRole::Moderator => require_owner(&action.author),
        GrantedRole::Writer => require_owner_or_moderator_for_delete(&action),
    }
}

pub fn validate_create_link_all_role_grants(
    _action: CreateLink,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("roles").path_entry_hash()?;
    let base_hash = base_address.into_entry_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No entry hash associated with link".to_string())
    ))?;
    if base_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "RoleGrant links must be linked from the roles anchor".to_string(),
        ));
    }
    let action_hash = target_address.into_action_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No action hash associated with link".to_string())
    ))?;
    let record = must_get_valid_record(action_hash)?;
    let _role_grant: RoleGrant = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Linked action must reference a RoleGrant entry".to_string()
        )))?;
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_delete_link_all_role_grants(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "AllRoleGrants links cannot be deleted".to_string(),
    ))
}

#[derive(Clone, PartialEq)]
#[hdk_entry_helper]
pub struct Membership {
    pub for_agent: AgentPubKey,
}

pub fn validate_create_membership(
    action: EntryCreationAction,
    membership: Membership,
) -> ExternResult<ValidateCallbackResult> {
    if action.author() != &membership.for_agent {
        return Ok(ValidateCallbackResult::Invalid(
            "Membership can only be created by the agent it is for".to_string(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_update_membership(
    _action: Update,
    _membership: Membership,
    _original_action: EntryCreationAction,
    _original_membership: Membership,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Membership entries cannot be updated".to_string(),
    ))
}

pub fn validate_delete_membership(
    action: Delete,
    _original_action: EntryCreationAction,
    original_membership: Membership,
) -> ExternResult<ValidateCallbackResult> {
    if action.author == original_membership.for_agent {
        return Ok(ValidateCallbackResult::Valid);
    }
    require_owner_or_moderator_for_delete(&action)
}

pub fn validate_create_link_all_memberships(
    _action: CreateLink,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("members").path_entry_hash()?;
    let base_hash = base_address.into_entry_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No entry hash associated with link".to_string())
    ))?;
    if base_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "Memberships must be linked from the members anchor".to_string(),
        ));
    }
    let action_hash = target_address.into_action_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No action hash associated with link".to_string())
    ))?;
    let record = must_get_valid_record(action_hash)?;
    let _membership: Membership = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Linked action must reference a Membership entry".to_string()
        )))?;
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_delete_link_all_memberships(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "AllMemberships links cannot be deleted".to_string(),
    ))
}

#[derive(Clone, PartialEq)]
#[hdk_entry_helper]
pub struct Ban {
    pub for_agent: AgentPubKey,
    pub role_evidence: Option<ActionHash>,
}

pub fn validate_create_ban(
    action: EntryCreationAction,
    ban: Ban,
) -> ExternResult<ValidateCallbackResult> {
    if action.author() == &ban.for_agent {
        return Ok(ValidateCallbackResult::Invalid(
            "Cannot ban yourself".to_string(),
        ));
    }
    require_owner_or_moderator(action.author(), ban.role_evidence)
}

pub fn validate_update_ban(
    _action: Update,
    _ban: Ban,
    _original_action: EntryCreationAction,
    _original_ban: Ban,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Ban entries cannot be updated".to_string(),
    ))
}

pub fn validate_delete_ban(
    action: Delete,
    _original_action: EntryCreationAction,
    _original_ban: Ban,
) -> ExternResult<ValidateCallbackResult> {
    require_owner(&action.author)
}

pub fn validate_create_link_all_bans(
    _action: CreateLink,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("bans").path_entry_hash()?;
    let base_hash = base_address.into_entry_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No entry hash associated with link".to_string())
    ))?;
    if base_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "Bans must be linked from the bans anchor".to_string(),
        ));
    }
    let action_hash = target_address.into_action_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No action hash associated with link".to_string())
    ))?;
    let record = must_get_valid_record(action_hash)?;
    let _ban: Ban = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Linked action must reference a Ban entry".to_string()
        )))?;
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_delete_link_all_bans(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "AllBans links cannot be deleted".to_string(),
    ))
}

#[derive(Clone, PartialEq)]
#[hdk_entry_helper]
pub struct Closed {
    pub closed_by: AgentPubKey,
}

pub fn validate_create_closed(
    action: EntryCreationAction,
    _closed: Closed,
) -> ExternResult<ValidateCallbackResult> {
    require_owner(action.author())
}

pub fn validate_update_closed(
    _action: Update,
    _closed: Closed,
    _original_action: EntryCreationAction,
    _original_closed: Closed,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Closed entries cannot be updated".to_string(),
    ))
}

pub fn validate_delete_closed(
    _action: Delete,
    _original_action: EntryCreationAction,
    _original_closed: Closed,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Closed entries cannot be deleted".to_string(),
    ))
}

pub fn validate_create_link_all_closed(
    _action: CreateLink,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("closed").path_entry_hash()?;
    let base_hash = base_address.into_entry_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No entry hash associated with link".to_string())
    ))?;
    if base_hash != path_entry_hash {
        return Ok(ValidateCallbackResult::Invalid(
            "Closed markers must be linked from the closed anchor".to_string(),
        ));
    }
    let action_hash = target_address.into_action_hash().ok_or(wasm_error!(
        WasmErrorInner::Guest("No action hash associated with link".to_string())
    ))?;
    let record = must_get_valid_record(action_hash)?;
    let _closed: Closed = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Linked action must reference a Closed entry".to_string()
        )))?;
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_delete_link_all_closed(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "AllClosed links cannot be deleted".to_string(),
    ))
}

#[derive(Clone, PartialEq)]
#[hdk_entry_helper]
pub struct RoleEvidenceEntry {
    pub role_evidence: ActionHash,
}

pub fn validate_create_role_evidence_entry(
    _action: EntryCreationAction,
    _role_evidence_entry: RoleEvidenceEntry,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}

pub fn validate_update_role_evidence_entry(
    _action: Update,
    _role_evidence_entry: RoleEvidenceEntry,
    _original_action: EntryCreationAction,
    _original_role_evidence_entry: RoleEvidenceEntry,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "RoleEvidenceEntry entries cannot be updated".to_string(),
    ))
}

pub fn validate_delete_role_evidence_entry(
    _action: Delete,
    _original_action: EntryCreationAction,
    _original_role_evidence_entry: RoleEvidenceEntry,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}

fn is_owner(agent: &AgentPubKey) -> ExternResult<bool> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() == 1 {
        return Ok(true);
    }
    let props = crate::Properties::try_from(info.modifiers.properties).map_err(|e| wasm_error!(e))?;
    Ok(agent == &props.progenitor)
}

fn require_owner(agent: &AgentPubKey) -> ExternResult<ValidateCallbackResult> {
    if is_owner(agent)? {
        Ok(ValidateCallbackResult::Valid)
    } else {
        Ok(ValidateCallbackResult::Invalid(
            "Only the conversation owner may perform this action".to_string(),
        ))
    }
}

fn fetch_role_grant(
    evidence: Option<ActionHash>,
) -> ExternResult<Result<RoleGrant, ValidateCallbackResult>> {
    let evidence_hash = match evidence {
        Some(hash) => hash,
        None => {
            return Ok(Err(ValidateCallbackResult::Invalid(
                "author is not the conversation owner and provided no role evidence".to_string(),
            )));
        }
    };
    let record = must_get_valid_record(evidence_hash)?;
    let role_grant: RoleGrant = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "role evidence must reference a RoleGrant entry".to_string()
        )))?;
    Ok(Ok(role_grant))
}

pub fn require_owner_or_moderator(
    author: &AgentPubKey,
    evidence: Option<ActionHash>,
) -> ExternResult<ValidateCallbackResult> {
    if is_owner(author)? {
        return Ok(ValidateCallbackResult::Valid);
    }
    let role_grant = match fetch_role_grant(evidence)? {
        Ok(role_grant) => role_grant,
        Err(invalid) => return Ok(invalid),
    };
    if &role_grant.for_agent != author {
        return Ok(ValidateCallbackResult::Invalid(
            "role evidence is for a different agent".to_string(),
        ));
    }
    if role_grant.role != GrantedRole::Moderator {
        return Ok(ValidateCallbackResult::Invalid(
            "role evidence is for Writer, not Moderator".to_string(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

pub fn require_membership(
    author: &AgentPubKey,
    evidence: Option<ActionHash>,
    read_only: bool,
) -> ExternResult<ValidateCallbackResult> {
    if is_owner(author)? {
        return Ok(ValidateCallbackResult::Valid);
    }
    let evidence_hash = match evidence {
        Some(hash) => hash,
        None => {
            return Ok(ValidateCallbackResult::Invalid(
                "author is not a member of this conversation".to_string(),
            ));
        }
    };
    let record = must_get_valid_record(evidence_hash)?;
    let entry = record.entry();
    let for_agent = if read_only {
        None
    } else {
        entry
            .to_app_option::<Membership>()
            .ok()
            .flatten()
            .map(|m| m.for_agent)
    };
    let for_agent = match for_agent {
        Some(agent) => agent,
        None => match entry.to_app_option::<RoleGrant>().ok().flatten() {
            Some(role_grant) => role_grant.for_agent,
            None => {
                return Ok(ValidateCallbackResult::Invalid(
                    "membership evidence must reference a Membership or RoleGrant entry"
                        .to_string(),
                ));
            }
        },
    };
    if &for_agent != author {
        return Ok(ValidateCallbackResult::Invalid(
            "membership evidence is for a different agent".to_string(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

pub fn require_owner_or_moderator_for_delete(
    action: &Delete,
) -> ExternResult<ValidateCallbackResult> {
    if is_owner(&action.author)? {
        return Ok(ValidateCallbackResult::Valid);
    }
    let record = must_get_valid_record(action.prev_action.clone())?;
    let evidence_entry: RoleEvidenceEntry = match record.entry().to_app_option().map_err(|e| wasm_error!(e))? {
        Some(entry) => entry,
        None => {
            return Ok(ValidateCallbackResult::Invalid(
                "author is not the conversation owner and the preceding action is not a RoleEvidenceEntry"
                    .to_string(),
            ));
        }
    };
    require_owner_or_moderator(&action.author, Some(evidence_entry.role_evidence))
}
