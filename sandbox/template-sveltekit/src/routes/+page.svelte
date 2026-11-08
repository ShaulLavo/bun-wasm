<script lang="ts">
  import { onMount } from "svelte";
  let hydrated = $state(false);
  onMount(() => { hydrated = true; });
  let { data } = $props();
  let count = $state(0);
</script>
<h1 id="message" data-hydrated={hydrated}>Hello from sveltekit</h1>
<p id="server-value">{data.value}</p>
<button id="increment" disabled={!hydrated} onclick={() => count++}>Increment</button>
<output id="count">{count}</output>
