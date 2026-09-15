import { CallableCell, PlayerApp } from '@holochain/tryorama';
import { NewEntryAction, ActionHash, AgentPubKey, Record, AppBundleSource, SignalType, fakeActionHash, fakeAgentPubKey, fakeEntryHash, fakeDnaHash } from '@holochain/client';



export async function sampleConfig(cell: CallableCell, partialConfig = {}) {
    return {
        ...{
	  title: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
	  image: "",
        },
        ...partialConfig
    };
}

export async function setConfig(cell: CallableCell, config = undefined): Promise<void> {
    return cell.callZome({
      zome_name: "relay",
      fn_name: "set_config",
      payload: config || await sampleConfig(cell),
    });
}



export async function sampleMessage(cell: CallableCell, partialMessage = {}) {
    return {
        ...{
	  content: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
	  bucket: 0,
	  images: [],
	  message_type: "User",
        },
        ...partialMessage
    };
}

export async function createMessage(cell: CallableCell, message = undefined, agents: any[] = []): Promise<Record> {
    return cell.callZome({
      zome_name: "relay",
      fn_name: "create_message",
      payload: {
        message: message || await sampleMessage(cell),
        agents,
      },
    });
}

export function captureSignals(player: PlayerApp): any[] {
  const signals: any[] = [];
  player.appWs.on("signal", (signal) => {
    if (signal.type === SignalType.App) {
      signals.push(signal.value.payload);
    }
  });
  return signals;
}

export function signalsOfType(signals: any[], type: string): any[] {
  return signals.filter((s) => s?.type === type);
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function createConference(
  cell: CallableCell,
  participants: AgentPubKey[],
): Promise<{ room_id: string; joined_existing: boolean }> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "create_conference",
    payload: { participants },
  });
}

export async function joinConference(
  cell: CallableCell,
  room_id: string,
  participants: AgentPubKey[],
): Promise<void> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "join_conference",
    payload: { room_id, participants },
  });
}

export async function rejectConference(
  cell: CallableCell,
  room_id: string,
  participants: AgentPubKey[],
): Promise<void> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "reject_conference",
    payload: { room_id, participants },
  });
}

export async function endConferenceForAll(
  cell: CallableCell,
  room_id: string,
  participants: AgentPubKey[],
): Promise<void> {
  return cell.callZome({
    zome_name: "relay",
    fn_name: "end_conference_for_all",
    payload: { room_id, participants },
  });
}

