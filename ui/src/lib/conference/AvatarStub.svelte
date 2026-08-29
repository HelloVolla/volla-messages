<script lang="ts">
  export let agentPubKeyB64: string = "";
  export let size: number = 32;
  export let cellIdB64: string | undefined = undefined;
</script>

<div data-testid="avatar" data-agent={agentPubKeyB64} data-size={size} data-cell={cellIdB64}></div>
