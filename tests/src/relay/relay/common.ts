import { CallableCell } from '@holochain-open-dev/tryorama';
import { NewEntryAction, ActionHash, Record, AppBundleSource, fakeActionHash, fakeAgentPubKey, fakeEntryHash, fakeDnaHash } from '@holochain/client';



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

