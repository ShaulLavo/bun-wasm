<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
<template><main><h1 id="message">Hello from vite-vue</h1><button id="increment" @click="count++">Increment</button><p id="count">Count: {{ count }}</p></main></template>
