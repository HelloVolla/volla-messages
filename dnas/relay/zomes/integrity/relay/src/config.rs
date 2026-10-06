use hdi::prelude::*;
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct Config {
    pub title: String,
    pub image: String,
}
pub fn validate_create_config(
    _action: TypedAction<EntryCreationData>,
    _config: Config,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_update_config(
    _action: TypedAction<UpdateData>,
    _config: Config,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_config(
    _action: TypedAction<DeleteData>,
    _original_action: TypedAction<EntryCreationData>,
    _original_config: Config,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(String::from("Config cannot be deleted")))
}
pub fn validate_create_link_config_updates(
    _action: TypedAction<CreateLinkData>,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    let path_entry_hash = Path::from("config").path_entry_hash()?;

    let base_hash = base_address
        .into_entry_hash()
        .ok_or(
            wasm_error!(
                WasmErrorInner::Guest("No entry hash associated with link".to_string())
            ),
        )?;
    if base_hash != path_entry_hash {
        return Err(wasm_error!(
            WasmErrorInner::Guest("Configs must be linked to path".to_string())
        ))
    }
    let action_hash = target_address
        .into_action_hash()
        .ok_or(
            wasm_error!(
                WasmErrorInner::Guest("No action hash associated with link".to_string())
            ),
        )?;
    let record = must_get_valid_record(action_hash)?;
    let _config: crate::Config = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(
            wasm_error!(
                WasmErrorInner::Guest("Linked action must reference an entry"
                .to_string())
            ),
        )?;
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_link_config_updates(
    _action: TypedAction<DeleteLinkData>,
    _original_action: TypedAction<CreateLinkData>,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(
        ValidateCallbackResult::Invalid(
            String::from("ConfigUpdates links cannot be deleted"),
        ),
    )
}
