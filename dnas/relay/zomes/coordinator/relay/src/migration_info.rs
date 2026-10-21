use crate::helper::ZomeFnInput;
use hdk::prelude::*;
use relay_integrity::*;

/// Write one piece of migration info into this conversation.
///
/// `shared: false` keeps it on this device only. `shared: true` publishes it
/// to the conversation and links it from the author's key, so other members
/// can read it with `get_migration_info_for_agent`.
#[derive(Serialize, Deserialize, Debug)]
pub struct CreateMigrationInfoInput {
    pub info: MigrationInfo,
    pub shared: bool,
}

#[hdk_extern]
pub fn create_migration_info(input: CreateMigrationInfoInput) -> ExternResult<ActionHash> {
    if !input.shared {
        return create_entry(&EntryTypes::MigrationInfoPrivate(input.info));
    }

    let tag = LinkTag::new(input.info.format.as_bytes().to_vec());
    let hash = create_entry(&EntryTypes::MigrationInfoPublic(input.info))?;
    create_link(
        agent_info()?.agent_initial_pubkey,
        hash.clone(),
        LinkTypes::AgentToMigrationInfo,
        tag,
    )?;
    Ok(hash)
}

fn has_format(record: &Record, format: &Option<String>) -> ExternResult<bool> {
    let Some(format) = format else {
        return Ok(true);
    };
    let info: Option<MigrationInfo> = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?;
    Ok(info.is_some_and(|i| &i.format == format))
}

/// This agent's own migration info in this conversation, private and shared,
/// optionally only one format. Read from the local source chain, so it never
/// touches the network.
#[hdk_extern]
pub fn get_my_migration_info(format: Option<String>) -> ExternResult<Vec<Record>> {
    let private: EntryType = UnitEntryTypes::MigrationInfoPrivate.try_into()?;
    let shared: EntryType = UnitEntryTypes::MigrationInfoPublic.try_into()?;
    let records = query(
        ChainQueryFilter::new()
            .entry_type(private)
            .entry_type(shared)
            .include_entries(true),
    )?;

    // A source chain keeps deleted entries; leave out the ones deleted since.
    let deleted: HashSet<ActionHash> = query(ChainQueryFilter::new().action_type(ActionType::Delete))?
        .into_iter()
        .filter_map(|r| match &r.action().data {
            ActionData::Delete(d) => Some(d.deletes_address.clone()),
            _ => None,
        })
        .collect();

    let mut results = Vec::new();
    for record in records {
        if !deleted.contains(record.action_address()) && has_format(&record, &format)? {
            results.push(record);
        }
    }
    Ok(results)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct MigrationInfoForAgentInput {
    pub agent: AgentPubKey,
    pub format: Option<String>,
}

/// Another member's shared migration info in this conversation. Private
/// entries are never visible here.
#[hdk_extern]
pub fn get_migration_info_for_agent(
    input: ZomeFnInput<MigrationInfoForAgentInput>,
) -> ExternResult<Vec<Record>> {
    let tag_prefix = input
        .input
        .format
        .as_ref()
        .map(|f| LinkTag::new(f.as_bytes().to_vec()));
    let links = get_links(
        LinkQuery {
            base: input.input.agent.clone().into(),
            link_type: LinkTypes::AgentToMigrationInfo.try_into_filter()?,
            tag_prefix,
            after: None,
            before: None,
            author: None,
        },
        input.get_strategy(),
    )?;

    let mut results = Vec::new();
    for link in links {
        let Some(hash) = link.target.into_action_hash() else {
            continue;
        };
        if let Some(record) = get(hash, input.get_options())? {
            // The tag matches by prefix; check the format exactly.
            if has_format(&record, &input.input.format)? {
                results.push(record);
            }
        }
    }
    Ok(results)
}

/// Delete one of this agent's migration info entries, and its link if shared.
#[hdk_extern]
pub fn delete_migration_info(hash: ActionHash) -> ExternResult<ActionHash> {
    let links = get_links(
        LinkQuery {
            base: agent_info()?.agent_initial_pubkey.into(),
            link_type: LinkTypes::AgentToMigrationInfo.try_into_filter()?,
            tag_prefix: None,
            after: None,
            before: None,
            author: None,
        },
        GetStrategy::Local,
    )?;
    for link in links {
        if link.target.clone().into_action_hash() == Some(hash.clone()) {
            delete_link(link.create_link_hash, GetOptions::local())?;
        }
    }
    delete_entry(hash)
}
