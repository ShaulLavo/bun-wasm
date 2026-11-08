<script setup lang="ts">
const route = useRoute();
const count = ref(0);
const { data } = await useFetch('/api/value', { query: { value: route.query.value ?? 'initial' } });
</script>
<template>
  <main>
    <h1 id="message">Hello from nuxt</h1>
    <p id="server-value">{{ data?.value }}</p>
    <button id="increment" @click="count++">Increment</button>
    <output id="count">{{ count }}</output>
  </main>
</template>
