use hc_zome_file_storage_integrity::*;
use hdk::prelude::*;

pub fn create_relaxed<I, E, E2>(input: I) -> ExternResult<ActionHash>
where
    ScopedEntryDefIndex: for<'a> TryFrom<&'a I, Error = E2>,
    EntryVisibility: for<'a> From<&'a I>,
    Entry: TryFrom<I, Error = E>,
    WasmError: From<E>,
    WasmError: From<E2>,
{
    let ScopedEntryDefIndex {
        zome_index,
        zome_type: entry_def_index,
    } = (&input).try_into()?;
    let visibility = EntryVisibility::from(&input);
    let create_input = CreateInput::new(
        EntryDefLocation::app(zome_index, entry_def_index),
        visibility,
        input.try_into()?,
        ChainTopOrdering::Relaxed,
    );
    create(create_input)
}

#[hdk_extern]
pub fn create_file_chunk(file_chunk: FileChunk) -> ExternResult<EntryHash> {
    let file_chunk_hash = hash_entry(&file_chunk)?;
    create_relaxed(&EntryTypes::FileChunk(file_chunk))?;
    Ok(file_chunk_hash)
}

#[hdk_extern]
pub fn create_file_metadata(file_metadata: FileMetadata) -> ExternResult<EntryHash> {
    let hash = hash_entry(&file_metadata)?;
    create_relaxed(&EntryTypes::FileMetadata(file_metadata))?;
    Ok(hash)
}

/// Input struct matching the @holochain-open-dev/file-storage JS client v0.601+
/// which sends `{ input: EntryHash, local: bool }` rather than a bare EntryHash.
#[derive(Serialize, Deserialize, Debug)]
pub struct GetInput {
    pub input: EntryHash,
    pub local: bool,
}

#[hdk_extern]
pub fn get_file_metadata(get_input: GetInput) -> ExternResult<FileMetadata> {
    let options = if get_input.local {
        GetOptions::local()
    } else {
        GetOptions::network()
    };
    let record = get(get_input.input, options)?
        .ok_or(wasm_error!(WasmErrorInner::Guest("File not found".into())))?;
    let file_metadata: FileMetadata = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Malformed file metadata".into()
        )))?;
    Ok(file_metadata)
}

#[hdk_extern]
pub fn get_file_chunk(get_input: GetInput) -> ExternResult<FileChunk> {
    let options = if get_input.local {
        GetOptions::local()
    } else {
        GetOptions::network()
    };
    let record = get(get_input.input, options)?
        .ok_or(wasm_error!(WasmErrorInner::Guest("File not found".into())))?;
    let file_chunk: FileChunk = record
        .entry()
        .to_app_option()
        .map_err(|e| wasm_error!(e))?
        .ok_or(wasm_error!(WasmErrorInner::Guest(
            "Malformed file chunk".into()
        )))?;
    Ok(file_chunk)
}