import {
  encodeHashToBase64,
  type AgentPubKeyB64,
  type ClonedCell,
  type ProvisionedCell,
} from "@holochain/client";
import { type Invalidator, type Subscriber, type Unsubscriber } from "svelte/store";
import { encodeCellIdToBase64, makeFullName } from "$lib/utils";
import type { CellIdB64, CreateProfileInputUI, Profile, ProfileExtended } from "$lib/types";
import type { RelayClient } from "./RelayClient";
import { EntryRecord } from "@holochain-open-dev/utils";
import { flatten } from "lodash-es";
import {
  createGenericKeyKeyValueStore,
  deriveGenericKeyValueStore,
  type GenericKeyKeyValueStore,
} from "./generic/GenericKeyKeyValueStore";
import type {
  GenericKeyValueStore,
  GenericKeyValueStoreData,
  GenericKeyValueStoreDataExtended,
} from "./generic/GenericKeyValueStore";

export interface ProfilesExtendedObj {
  [agentPubKeyB64: AgentPubKeyB64]: ProfileExtended;
}

export interface ProfileStore extends GenericKeyKeyValueStore<ProfileExtended> {
  initialize: () => Promise<void>;
  createProfile: (val: CreateProfileInputUI) => Promise<void>;
  updateProfile: (val: CreateProfileInputUI) => Promise<void>;
  repairMyConversationProfiles: () => Promise<number>;
  load: (key: CellIdB64, local: boolean) => Promise<void>;
  subscribe: (
    this: void,
    run: Subscriber<GenericKeyValueStoreDataExtended<GenericKeyValueStoreData<ProfileExtended>>>,
    invalidate?:
      | Invalidator<GenericKeyValueStoreDataExtended<GenericKeyValueStoreData<ProfileExtended>>>
      | undefined,
  ) => Unsubscriber;
}

/**
 * Creates a store for managing profiles
 *
 * @param client
 * @returns
 */
export function createProfileStore(client: RelayClient): ProfileStore {
  const profiles = createGenericKeyKeyValueStore<ProfileExtended>();

  /**
   * Fetch contacts data and load into writable
   */
  async function initialize() {
    // Get all relay cells
    const cellInfos = flatten(
      await Promise.all([client.getRelayClonedCellInfos(), client.getRelayProvisionedCellInfo()]),
    );

    // Get all profiles in all relay cells
    // Ignore any failures
    const data = (
      await Promise.allSettled(
        cellInfos.map(async (cellInfo) => [
          encodeCellIdToBase64(cellInfo.cell_id),
          await _loadProfiles(cellInfo, true), // on initialize load only local
        ]),
      )
    )
      .filter((p) => p.status === "fulfilled")
      .map((p) => p.value);

    // Add all profiles to writable
    profiles.set(Object.fromEntries(data));
  }

  /**
   * Create your profile
   *
   * @param val
   */
  async function createProfile(val: CreateProfileInputUI) {
    const input = {
      nickname: makeFullName(val.firstName, val.lastName),
      fields: val,
    };
    const myPubKeyB64 = encodeHashToBase64(client.client.myPubKey);

    // Get all relay cells
    const cellInfos = flatten(
      await Promise.all([client.getRelayClonedCellInfos(), client.getRelayProvisionedCellInfo()]),
    );

    // Create profile in all relay cells
    // Ignore any failures
    const promises = await Promise.allSettled(
      cellInfos.map(async (cellInfo) => {
        const record = await client.createProfile(cellInfo.cell_id, input);
        const profile = new EntryRecord<Profile>(record).entry;
        if (!profile) throw new Error("Failed to get profile entry");

        return {
          cellIdB64: encodeCellIdToBase64(cellInfo.cell_id),
          agentPubKeyB64: myPubKeyB64,
          profileExtended: {
            profile,
            publicKeyB64: myPubKeyB64,
          },
        };
      }),
    );
    const data = promises.filter((p) => p.status === "fulfilled").map((p) => p.value);

    // Add all profiles to writable
    data.forEach(({ cellIdB64, agentPubKeyB64, profileExtended }) =>
      profiles.setKeyKeyValue(cellIdB64, agentPubKeyB64, profileExtended),
    );
  }

  /**
   * Update your profile
   */
  async function updateProfile(val: CreateProfileInputUI) {
    const input = {
      nickname: makeFullName(val.firstName, val.lastName),
      fields: val,
    };
    const myPubKeyB64 = encodeHashToBase64(client.client.myPubKey);

    // Get all relay cells
    const cellInfos = flatten(
      await Promise.all([client.getRelayClonedCellInfos(), client.getRelayProvisionedCellInfo()]),
    );

    // Create profile in all relay cells
    // Ignore any failures
    const promises = await Promise.allSettled(
      cellInfos.map(async (cellInfo) => {
        const record = await client.updateProfile(cellInfo.cell_id, input);
        const profile = new EntryRecord<Profile>(record).entry;
        if (!profile) throw new Error("Failed to get profile entry");

        return {
          cellIdB64: encodeCellIdToBase64(cellInfo.cell_id),
          agentPubKeyB64: myPubKeyB64,
          profileExtended: {
            profile,
            publicKeyB64: myPubKeyB64,
          },
        };
      }),
    );
    const data = promises.filter((p) => p.status === "fulfilled").map((p) => p.value);

    // Add all profiles to writable
    data.forEach(({ cellIdB64, agentPubKeyB64, profileExtended }) => {
      profiles.setKeyKeyValue(cellIdB64, agentPubKeyB64, profileExtended);
    });
  }

  /**
   * Write your profile into active conversations that do not hold it.
   *
   * Joining creates the conversation first and writes your profile into it as
   * a second step. When that step failed — the app closed mid-join, a timeout —
   * nothing retried it: the conversation stayed in your list while you were
   * missing from its member list. Run once per launch.
   *
   * Only local data is checked: your own profile, if it exists, was written on
   * this device, so a local miss is a real miss and the write never duplicates
   * one. Archived conversations are skipped; they are repaired after being
   * un-archived and the app restarted.
   *
   * @returns how many conversations were repaired
   */
  async function repairMyConversationProfiles(): Promise<number> {
    const myPubKey = client.client.myPubKey;
    const myPubKeyB64 = encodeHashToBase64(myPubKey);

    // No profile yet (first run, before creating one): nothing to copy.
    const provisioned = await client.getRelayProvisionedCellInfo();
    if (!(await client.getAgentProfile(provisioned.cell_id, myPubKey, true))) return 0;

    let repaired = 0;
    for (const cell of await client.getRelayClonedCellInfos()) {
      if (!cell.enabled) continue;
      const cellIdB64 = encodeCellIdToBase64(cell.cell_id);
      try {
        if (await client.getAgentProfile(cell.cell_id, myPubKey, true)) continue;

        const record = await client.ensureMyProfileForConversation(cell.cell_id);
        const profile = new EntryRecord<Profile>(record).entry;
        if (profile) {
          profiles.setKeyKeyValue(cellIdB64, myPubKeyB64, { profile, publicKeyB64: myPubKeyB64 });
        }
        repaired++;
        console.log(`[profile] wrote missing profile into conversation ${cellIdB64.slice(0, 16)}`);
      } catch (e) {
        console.warn(`[profile] could not repair profile in ${cellIdB64.slice(0, 16)}`, e);
      }
    }
    return repaired;
  }

  async function load(key: CellIdB64, local: boolean) {
    // Get all relay cells
    const cellInfos = flatten(
      await Promise.all([client.getRelayClonedCellInfos(), client.getRelayProvisionedCellInfo()]),
    );

    // Find selected cell
    const cellInfo = cellInfos.find((c) => encodeCellIdToBase64(c.cell_id) === key);
    if (!cellInfo) throw new Error(`Failed to get CellInfo for cellIdB64 ${key}`);

    // Fetch profiles for cell
    const data = await _loadProfiles(cellInfo, local);
    profiles.setKeyValue(key, data);
  }

  async function _loadProfiles(
    cellInfo: ClonedCell | ProvisionedCell,
    local: boolean,
  ): Promise<{ [agentPubKeyB64: string]: ProfileExtended }> {
    const profilesExtended = await client.getAllProfiles(cellInfo.cell_id, local);

    return Object.fromEntries(profilesExtended.map((p) => [p.publicKeyB64, p]));
  }

  return {
    ...profiles,
    initialize,
    load,
    createProfile,
    updateProfile,
    repairMyConversationProfiles,
  };
}

export interface CellProfileStore extends GenericKeyValueStore<ProfileExtended> {
  load: (local: boolean) => Promise<void>;
}

export function deriveCellProfileStore(
  profileStore: ProfileStore,
  cellIdB64: CellIdB64,
): CellProfileStore {
  const store = deriveGenericKeyValueStore(profileStore, cellIdB64);

  return {
    ...store,
    load: (local: boolean) => profileStore.load(cellIdB64, local),
  };
}
