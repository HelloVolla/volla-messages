use hdi::prelude::*;

/// Data carried across a breaking upgrade, written into a conversation after
/// it is rebuilt — for example a day of 1.x message history.
///
/// Deliberately generic, so that later migrations (more formats, images, a
/// future 2.x -> 3.x upgrade) reuse these entry types without another DNA hash
/// change. The DNA does not interpret `data`; readers check it, and skip any
/// `format` they do not understand.
///
/// Stored as two entry types with this same shape: `MigrationInfoPrivate`
/// stays on the author's device; `MigrationInfoPublic` is shared with the
/// conversation and found through an `AgentToMigrationInfo` link. Having both
/// from the start means switching between private and shared history later is
/// an app update, not a DNA change.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct MigrationInfo {
    /// What `data` holds, e.g. `"volla.history.day"`.
    pub format: String,
    /// Version of that format.
    pub version: u32,
    /// Which part of the format this entry is, e.g. a day bucket. Lets a reader
    /// fetch one part without decoding the rest.
    pub part: u32,
    /// Format-specific payload, opaque to the DNA.
    pub data: SerializedBytes,
}

pub const MIGRATION_INFO_FORMAT_MAX_LEN: usize = 64;

pub fn validate_create_migration_info(
    _action: TypedAction<EntryCreationData>,
    info: MigrationInfo,
) -> ExternResult<ValidateCallbackResult> {
    if info.format.is_empty() || info.format.len() > MIGRATION_INFO_FORMAT_MAX_LEN {
        return Ok(ValidateCallbackResult::Invalid(format!(
            "Migration info format must be 1 to {MIGRATION_INFO_FORMAT_MAX_LEN} bytes"
        )));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Migration info records what was carried over; changing it afterwards would
/// make it say something else. A wrong entry is deleted and written again.
pub fn validate_update_migration_info() -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Migration info cannot be updated".to_string(),
    ))
}

pub fn validate_delete_migration_info(
    action: TypedAction<DeleteData>,
    original_action: TypedAction<EntryCreationData>,
) -> ExternResult<ValidateCallbackResult> {
    if action.header.author != original_action.header.author {
        return Ok(ValidateCallbackResult::Invalid(
            "Only the author can delete migration info".to_string(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// An agent links only to their own shared migration info, from their own key.
pub fn validate_create_link_agent_to_migration_info(
    action: TypedAction<CreateLinkData>,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
) -> ExternResult<ValidateCallbackResult> {
    let Some(base_agent) = base_address.into_agent_pub_key() else {
        return Ok(ValidateCallbackResult::Invalid(
            "AgentToMigrationInfo base must be an agent key".to_string(),
        ));
    };
    if base_agent != action.header.author {
        return Ok(ValidateCallbackResult::Invalid(
            "An agent can only link migration info from their own key".to_string(),
        ));
    }

    let Some(target_hash) = target_address.into_action_hash() else {
        return Ok(ValidateCallbackResult::Invalid(
            "AgentToMigrationInfo target must be an action hash".to_string(),
        ));
    };
    let record = must_get_valid_record(target_hash)?;
    if *record.action().author() != action.header.author {
        return Ok(ValidateCallbackResult::Invalid(
            "An agent can only link their own migration info".to_string(),
        ));
    }

    // Both migration info types share one struct, so decoding the entry does
    // not tell them apart; the entry type recorded in the action does.
    let not_shared = || {
        Ok(ValidateCallbackResult::Invalid(
            "AgentToMigrationInfo must point at shared migration info".to_string(),
        ))
    };
    let Some(EntryType::App(def)) = record.action().entry_type() else {
        return not_shared();
    };
    let Some(entry) = record.entry().as_option() else {
        return not_shared();
    };
    match crate::EntryTypes::deserialize_from_type(def.zome_index, def.entry_index, entry)? {
        Some(crate::EntryTypes::MigrationInfoPublic(_)) => Ok(ValidateCallbackResult::Valid),
        _ => not_shared(),
    }
}

pub fn validate_delete_link_agent_to_migration_info(
    action: TypedAction<DeleteLinkData>,
    original_action: TypedAction<CreateLinkData>,
) -> ExternResult<ValidateCallbackResult> {
    if action.header.author != original_action.header.author {
        return Ok(ValidateCallbackResult::Invalid(
            "Only the author can remove a migration info link".to_string(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
