use hdk::prelude::*;
use relay_integrity::*;

use crate::helper::ZomeFnInput;
use crate::role::find_role_grant;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SetConfigInput {
    pub title: String,
    pub image: String,
}

#[hdk_extern]
pub fn set_config(input: SetConfigInput) -> ExternResult<()> {
    let me = agent_info()?.agent_initial_pubkey;
    let config = Config {
        title: input.title,
        image: input.image,
        role_evidence: find_role_grant(&me, GrantedRole::Moderator)?,
    };
    let config_hash = create_entry(&EntryTypes::Config(config))?;
    let path = Path::from("config");
    let _link = create_link(
        path.path_entry_hash()?,
        config_hash.clone(),
        LinkTypes::ConfigUpdates,
        (),
    )?;
    Ok(())
}

#[hdk_extern]
pub fn get_config(input: ZomeFnInput<()>) -> ExternResult<Option<Record>> {
    let path = Path::from("config");
    let links = get_links(
        LinkQuery {
            base: path.path_entry_hash()?.into(),
            link_type: LinkTypes::ConfigUpdates.try_into_filter()?,
            tag_prefix: None,
            after: None,
            before: None,
            author: None,
        },
        input.get_strategy(),
    )?;
    let latest_link = links
        .into_iter()
        .max_by(|link_a, link_b| link_a.timestamp.cmp(&link_b.timestamp));
    if let Some(link) = latest_link {
        let latest_config_hash =
            link.target
                .clone()
                .into_action_hash()
                .ok_or(wasm_error!(WasmErrorInner::Guest(
                    "No action hash associated with link".to_string()
                )))?;
        get(latest_config_hash, GetOptions::local())
    } else {
        Ok(None)
    }
}
