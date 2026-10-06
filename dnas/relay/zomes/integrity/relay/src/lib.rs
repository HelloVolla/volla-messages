pub mod contact;
pub use contact::*;
pub mod message;
pub use message::*;
pub mod config;
pub use config::*;
use hdi::prelude::*;

pub const MESSAGES_PATH_PREFIX: &str = "msg";

pub fn messages_path(bucket: u32) -> Path {
    Path::from(format!("{}.{}", MESSAGES_PATH_PREFIX, bucket))
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Config(Config),
    Message(Message),
    Contact(Contact),
}

#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    ConfigUpdates,
    MessageUpdates,
    AllMessages,
    ContactToContacts,
    ContactUpdates,
    AllContacts,
}

#[derive(Serialize, Deserialize, Debug, SerializedBytes, Clone)]
pub struct MembraneProofData {
    pub conversation_id: String,
    pub for_agent: AgentPubKey,
    pub as_role: u32,
}

#[derive(Serialize, Deserialize, Debug, SerializedBytes)]
pub struct MembraneProofEnvelope {
    pub signature: Signature,
    pub data: MembraneProofData,
}

#[derive(Serialize, Deserialize, Debug, Clone, SerializedBytes, PartialEq)]
pub enum Privacy {
    Private,
    Public,
}

#[derive(Serialize, Deserialize, Debug, SerializedBytes, Clone)]
pub struct Properties {
    pub created: Timestamp,
    pub privacy: Privacy,
    pub progenitor: AgentPubKey,
}

pub fn check_agent(
    agent_pub_key: AgentPubKey,
    membrane_proof: Option<MembraneProof>,
) -> ExternResult<ValidateCallbackResult> {
    let info = dna_info()?;
    if info.modifiers.properties.bytes().len() == 1 {
        return Ok(ValidateCallbackResult::Valid);
    }
    let props = Properties::try_from(info.modifiers.properties)
        .map_err(|e| wasm_error!(e))?;
    if props.privacy == Privacy::Public {
        return Ok(ValidateCallbackResult::Valid);
    }
    if agent_pub_key == props.progenitor {
        return Ok(ValidateCallbackResult::Valid);
    }
    match membrane_proof {
        None => {
            Ok(
                ValidateCallbackResult::Invalid(
                    "membrane proof must be provided".to_string(),
                ),
            )
        }
        Some(serialized_proof) => {
            let envelope = MembraneProofEnvelope::try_from((*serialized_proof).clone())
                .map_err(|e| wasm_error!(e))?;
            if envelope.data.conversation_id != info.modifiers.network_seed {
                return Ok(
                    ValidateCallbackResult::Invalid(
                        "membrane proof is not for this conversation".to_string(),
                    ),
                );
            }
            if envelope.data.for_agent != agent_pub_key {
                return Ok(
                    ValidateCallbackResult::Invalid(
                        "membrane proof is not for this agent".to_string(),
                    ),
                );
            }
            if verify_signature(props.progenitor, envelope.signature, envelope.data)? {
                return Ok(ValidateCallbackResult::Valid);
            }
            Ok(
                ValidateCallbackResult::Invalid(
                    "membrane proof signature invalid".to_string(),
                ),
            )
        }
    }
}

#[hdk_extern]
pub fn genesis_self_check(
    data: GenesisSelfCheckData,
) -> ExternResult<ValidateCallbackResult> {
    check_agent(data.agent_key, data.membrane_proof)
}

pub fn validate_agent_joining(
    agent_pub_key: AgentPubKey,
    membrane_proof: &Option<MembraneProof>,
) -> ExternResult<ValidateCallbackResult> {
    check_agent(agent_pub_key, (*membrane_proof).clone())
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateEntry(op_entry) => match op_entry {
            OpEntry::CreateEntry { app_entry, action } => {
                let action = TypedAction {
                    header: action.header,
                    data: EntryCreationData::Create(action.data),
                };
                match app_entry {
                    EntryTypes::Config(config) => validate_create_config(action, config),
                    EntryTypes::Message(message) => validate_create_message(action, message),
                    EntryTypes::Contact(contact) => validate_create_contact(action, contact),
                }
            }
            OpEntry::UpdateEntry { app_entry, action } => {
                let action = TypedAction {
                    header: action.header,
                    data: EntryCreationData::Update(action.data),
                };
                match app_entry {
                    EntryTypes::Config(config) => validate_create_config(action, config),
                    EntryTypes::Message(message) => validate_create_message(action, message),
                    EntryTypes::Contact(contact) => validate_create_contact(action, contact),
                }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::Update(update_entry) => match update_entry {
            OpUpdate::Entry { app_entry, action } => {
                let original_action_hash = action.original_action_address.clone();
                let original_action = must_get_action(original_action_hash.clone())?
                    .action()
                    .to_owned();
                let original_create_action =
                    match TypedAction::<EntryCreationData>::try_from(original_action) {
                        Ok(action) => action,
                        Err(e) => {
                            return Ok(ValidateCallbackResult::Invalid(format!(
                                "Expected original action to create an entry: {e:?}"
                            )));
                        }
                    };
                match app_entry {
                    EntryTypes::Contact(contact) => {
                        let original_app_entry = must_get_valid_record(original_action_hash)?;
                        let original_contact = match Contact::try_from(original_app_entry) {
                            Ok(entry) => entry,
                            Err(e) => {
                                return Ok(ValidateCallbackResult::Invalid(format!(
                                    "Expected to get Contact from Record: {e:?}"
                                )));
                            }
                        };
                        validate_update_contact(
                            action,
                            contact,
                            original_create_action,
                            original_contact,
                        )
                    }
                    EntryTypes::Message(message) => validate_update_message(action, message),
                    EntryTypes::Config(config) => validate_update_config(action, config),
                }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::Delete(OpDelete { action }) => {
            let original_action_hash = action.deletes_address.clone();
            let original_record = must_get_valid_record(original_action_hash)?;
            let original_record_action = original_record.action().clone();
            let original_action =
                match TypedAction::<EntryCreationData>::try_from(original_record_action) {
                    Ok(action) => action,
                    Err(e) => {
                        return Ok(ValidateCallbackResult::Invalid(format!(
                            "Expected original action to create an entry: {e:?}"
                        )));
                    }
                };
            let app_entry_type = match original_action.entry_type() {
                EntryType::App(app_entry_type) => app_entry_type.clone(),
                _ => {
                    return Ok(ValidateCallbackResult::Valid);
                }
            };
            let entry = match original_record.entry().as_option() {
                Some(entry) => entry,
                None => {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original record for a delete must contain an entry".to_string(),
                    ));
                }
            };
            let original_app_entry = match EntryTypes::deserialize_from_type(
                app_entry_type.zome_index,
                app_entry_type.entry_index,
                entry,
            )? {
                Some(app_entry) => app_entry,
                None => {
                    return Ok(ValidateCallbackResult::Invalid(
                        "Original app entry must be one of the defined entry types for this zome"
                            .to_string(),
                    ));
                }
            };
            match original_app_entry {
                EntryTypes::Contact(original_contact) => {
                    validate_delete_contact(action, original_action, original_contact)
                }
                EntryTypes::Message(original_message) => {
                    validate_delete_message(action, original_action, original_message)
                }
                EntryTypes::Config(_original_config) => Ok(ValidateCallbackResult::Invalid(
                    "Cannot delete Config Entry".to_string(),
                )),
            }
        }
        FlatOp::Link(OpLink::CreateLink { link_type, action }) => {
            let base_address = action.base_address.clone();
            let target_address = action.target_address.clone();
            let tag = action.tag.clone();
            match link_type {
                LinkTypes::ConfigUpdates => {
                    validate_create_link_config_updates(action, base_address, target_address, tag)
                }
                LinkTypes::MessageUpdates => {
                    validate_create_link_message_updates(action, base_address, target_address, tag)
                }
                LinkTypes::AllMessages => {
                    validate_create_link_all_messages(action, base_address, target_address, tag)
                }
                LinkTypes::ContactToContacts => validate_create_link_contact_to_contacts(
                    action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::ContactUpdates => {
                    validate_create_link_contact_updates(action, base_address, target_address, tag)
                }
                LinkTypes::AllContacts => {
                    validate_create_link_all_contacts(action, base_address, target_address, tag)
                }
            }
        }
        FlatOp::Link(OpLink::DeleteLink {
            original_action,
            link_type,
            action,
        }) => {
            let base_address = original_action.base_address.clone();
            let target_address = original_action.target_address.clone();
            let tag = original_action.tag.clone();
            match link_type {
                LinkTypes::ConfigUpdates => validate_delete_link_config_updates(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::MessageUpdates => validate_delete_link_message_updates(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllMessages => validate_delete_link_all_messages(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::ContactToContacts => validate_delete_link_contact_to_contacts(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::ContactUpdates => validate_delete_link_contact_updates(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllContacts => validate_delete_link_all_contacts(
                    action,
                    original_action,
                    base_address,
                    target_address,
                    tag,
                ),
            }
        }
        FlatOp::CreateRecord(store_record) => match store_record {
            OpRecord::CreateEntry { app_entry, action } => {
                let action = TypedAction {
                    header: action.header,
                    data: EntryCreationData::Create(action.data),
                };
                match app_entry {
                    EntryTypes::Config(config) => validate_create_config(action, config),
                    EntryTypes::Message(message) => validate_create_message(action, message),
                    EntryTypes::Contact(contact) => validate_create_contact(action, contact),
                }
            }
            OpRecord::UpdateEntry { app_entry, action } => {
                let original_action_hash = action.original_action_address.clone();
                let original_record = must_get_valid_record(original_action_hash)?;
                let original_action = match TypedAction::<EntryCreationData>::try_from(
                    original_record.action().clone(),
                ) {
                    Ok(action) => action,
                    Err(_) => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "Original action for an update must be a Create or Update action"
                                .to_string(),
                        ));
                    }
                };
                let create_action = TypedAction {
                    header: action.header.clone(),
                    data: EntryCreationData::Update(action.data.clone()),
                };
                match app_entry {
                    EntryTypes::Config(config) => {
                        let result = validate_create_config(create_action, config.clone())?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_config: Option<Config> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let _original_config = match original_config {
                                Some(config) => config,
                                None => {
                                    return Ok(ValidateCallbackResult::Invalid(
                                        "The updated entry type must be the same as the original entry type"
                                            .to_string(),
                                    ));
                                }
                            };
                            validate_update_config(action, config)
                        } else {
                            Ok(result)
                        }
                    }
                    EntryTypes::Message(message) => {
                        let result = validate_create_message(create_action, message.clone())?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_message: Option<Message> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let _original_message = match original_message {
                                Some(message) => message,
                                None => {
                                    return Ok(ValidateCallbackResult::Invalid(
                                        "The updated entry type must be the same as the original entry type"
                                            .to_string(),
                                    ));
                                }
                            };
                            validate_update_message(action, message)
                        } else {
                            Ok(result)
                        }
                    }
                    EntryTypes::Contact(contact) => {
                        let result = validate_create_contact(create_action, contact.clone())?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_contact: Option<Contact> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_contact = match original_contact {
                                Some(contact) => contact,
                                None => {
                                    return Ok(ValidateCallbackResult::Invalid(
                                        "The updated entry type must be the same as the original entry type"
                                            .to_string(),
                                    ));
                                }
                            };
                            validate_update_contact(
                                action,
                                contact,
                                original_action,
                                original_contact,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                }
            }
            OpRecord::DeleteEntry { action } => {
                let original_action_hash = action.deletes_address.clone();
                let original_record = must_get_valid_record(original_action_hash)?;
                let original_action = match TypedAction::<EntryCreationData>::try_from(
                    original_record.action().clone(),
                ) {
                    Ok(action) => action,
                    Err(_) => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "Original action for a delete must be a Create or Update action"
                                .to_string(),
                        ));
                    }
                };
                let app_entry_type = match original_action.entry_type() {
                    EntryType::App(app_entry_type) => app_entry_type.clone(),
                    _ => {
                        return Ok(ValidateCallbackResult::Valid);
                    }
                };
                let entry = match original_record.entry().as_option() {
                    Some(entry) => entry,
                    None => {
                        if original_action.entry_type().visibility().is_public() {
                            return Ok(ValidateCallbackResult::Invalid(
                                "Original record for a delete of a public entry must contain an entry"
                                    .to_string(),
                            ));
                        } else {
                            return Ok(ValidateCallbackResult::Valid);
                        }
                    }
                };
                let original_app_entry = match EntryTypes::deserialize_from_type(
                    app_entry_type.zome_index,
                    app_entry_type.entry_index,
                    entry,
                )? {
                    Some(app_entry) => app_entry,
                    None => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "Original app entry must be one of the defined entry types for this zome"
                                .to_string(),
                        ));
                    }
                };
                match original_app_entry {
                    EntryTypes::Config(original_config) => {
                        validate_delete_config(action, original_action, original_config)
                    }
                    EntryTypes::Message(original_message) => {
                        validate_delete_message(action, original_action, original_message)
                    }
                    EntryTypes::Contact(original_contact) => {
                        validate_delete_contact(action, original_action, original_contact)
                    }
                }
            }
            OpRecord::CreateLink { link_type, action } => {
                let base_address = action.base_address.clone();
                let target_address = action.target_address.clone();
                let tag = action.tag.clone();
                match link_type {
                    LinkTypes::ConfigUpdates => validate_create_link_config_updates(
                        action,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::MessageUpdates => validate_create_link_message_updates(
                        action,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllMessages => {
                        validate_create_link_all_messages(action, base_address, target_address, tag)
                    }
                    LinkTypes::ContactToContacts => validate_create_link_contact_to_contacts(
                        action,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::ContactUpdates => validate_create_link_contact_updates(
                        action,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllContacts => {
                        validate_create_link_all_contacts(action, base_address, target_address, tag)
                    }
                }
            }
            OpRecord::DeleteLink { action } => {
                let record = must_get_valid_record(action.link_add_address.clone())?;
                let create_link = match TypedAction::<CreateLinkData>::try_from(
                    record.action().clone(),
                ) {
                    Ok(create_link) => create_link,
                    Err(_) => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "The action that a DeleteLink deletes must be a CreateLink"
                                .to_string(),
                        ));
                    }
                };
                let link_type = match LinkTypes::from_type(
                    create_link.zome_index,
                    create_link.link_type,
                )? {
                    Some(lt) => lt,
                    None => {
                        return Ok(ValidateCallbackResult::Valid);
                    }
                };
                let base_address = action.base_address.clone();
                let target_address = create_link.target_address.clone();
                let tag = create_link.tag.clone();
                match link_type {
                    LinkTypes::ConfigUpdates => validate_delete_link_config_updates(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::MessageUpdates => validate_delete_link_message_updates(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllMessages => validate_delete_link_all_messages(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::ContactToContacts => validate_delete_link_contact_to_contacts(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::ContactUpdates => validate_delete_link_contact_updates(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                    LinkTypes::AllContacts => validate_delete_link_all_contacts(
                        action,
                        create_link,
                        base_address,
                        target_address,
                        tag,
                    ),
                }
            }
            OpRecord::CreatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::Dna { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::OpenChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CloseChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::InitZomesComplete { .. } => Ok(ValidateCallbackResult::Valid),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::AgentActivity(agent_activity) => match agent_activity {
            OpActivity::CreateAgent { agent, action } => {
                let prev = action
                    .prev_action()
                    .ok_or_else(|| {
                        wasm_error!(WasmErrorInner::Guest(
                            "expected a prior action before CreateAgent".into()
                        ))
                    })?
                    .clone();
                let previous_action = must_get_action(prev)?;
                match &previous_action.action().data {
                    ActionData::AgentValidationPkg(AgentValidationPkgData {
                        membrane_proof,
                        ..
                    }) => validate_agent_joining(agent, membrane_proof),
                    _ => Ok(ValidateCallbackResult::Invalid(
                        "The previous action for a `CreateAgent` action must be an `AgentValidationPkg`"
                            .to_string(),
                    )),
                }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
    }
}
